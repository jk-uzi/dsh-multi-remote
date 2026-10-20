/**
 * 预设 —— 远程会话的「独立工作间」。
 *
 * ## 为什么需要预设隔离
 *
 * DSH 里 `fs` 与 `shell` 是**全局单例服务**，一个会话只能有一个执行世界。
 * 所以不能「把全局的换掉」（那样本地会话也废了），只能**给远程会话单独配一套**：
 * 注册一份派生自用户默认配置的预设，在它的隔离域里把 `fs` / `shell` 换成远程实现。
 *
 * 隔离的是**手脚**，不是**大脑** —— persona、AGENTS.md、skills、todo、plan 模式、
 * 上下文压缩、子智能体全部保留。
 *
 * ## 三条实测得出的硬约束（踩过的坑，不是推测）
 *
 * 1. **必须用运行时 `agentPresets.register()`**。写 `$DSH_HOME/.agent-presets/` 的
 *    老方式在当前 DSH 已死（写了没人读），会话会**静默留在本机跑**，
 *    而界面上却显示已连上远程 —— 这是本项目最坏的失败模式。
 *
 * 2. **预设行的 `name` 必须是可解析的模块 specifier**（包名或包子路径）。
 *    用绝对文件路径（`<盘符>:/...`）会因被当成 URL 协议而**永不启动**，
 *    诊断显示 `never started`、`entry.fiber === undefined`。
 *
 * 3. **注册/激活失败只写一条 warn、不抛错**（宿主 `activate()` 里
 *    `record.broken = error.message` + `logger.warn`）。
 *    所以我们必须**自己回读诊断**，否则会静默降级 —— 见 {@link PresetRegistry.verify}。
 *
 * ## 时机约束（实测确认）
 *
 * 预设**只能在会话开始第一轮之前选定**，之后 `select()` 抛 `agent-preset/locked`。
 * 由此推出用户流程的硬约束：
 *
 * ```
 * 先选远程工作区 → 再建会话 → 会话自动用上我们的预设   ✅
 * 先建会话 → 再连远程                                  ❌ 换不了
 * ```
 */
import { PLAN_MODE_SECTION } from './plan-mode-section.js'

/** 预设 id 前缀。带前缀是为了不与其它插件（例如 remote-ssh 类）生成的 id 撞车。 */
export const PRESET_ID_PREFIX = 'multi-remote'

/**
 * **单一远程模式的预设 id（固定，不派生）**。
 *
 * 方案 A（2026-10-09）：预设收敛成一个「远程模式」—— 域内 provider 不再
 * 绑固定连接，而是按路径动态路由（见 `workspace-routes.js`）。所以预设 id
 * 与「连接档案 / 远程根」**无关**，永远是这一个。
 *
 * 好处：模式选择器里永远只有一个「远程模式」（宿主预设是全局的，每连接一个
 * 预设就会出现 N 个，且都能被任何会话选到 —— 写错项目）。会话日志里存的
 * 也是这个稳定 id，重启恢复永远找得到。
 */
export const PRESET_ID = PRESET_ID_PREFIX

/** 本插件在预设行里引用的模块 specifier 前缀。必须等于包名。 */
export const PLUGIN_PACKAGE = '@jk-uzi/dsh-multi-remote'

/**
 * 需要隔离的服务名。
 *
 * `fs` 与 `shell` 是 DSH 里**单例**的执行世界接缝；不隔离它们，
 * agent 的读写与命令就还落在本机。
 *
 * `terminals` 同样要隔离：宿主自带预设把 `terminals` 隔离在它自己的
 * `persistent-shell` 组里，所以**根上下文根本没有这个服务**
 * （实测：不隔离时插件的 `inject: ['terminals']` 一直 pending）。
 * 隔离之后我们域内会有一个实例，`registerBackend` 注册的就是它。
 */
export const ISOLATED_SERVICES = ['fs', 'shell', 'terminals']

/**
 * 提供 `terminals` 服务的行。
 *
 * 与宿主的 `minimal` 预设同一做法：服务本体 + 一个后端。
 * 官方那个本地 shell 后端（`dsh-terminal-bash`）**不挂** ——
 * 挂它要 `sandbox` / `sandbox-policy` / `subprocess`，而我们在 Windows 上
 * 那些沙箱执行器本来就起不来；而且远程会话本来也不该有本地终端。
 * 我们自己的后端由 `world/terminal.js` 在域内注册。
 */
export const TERMINAL_SERVICE_ROWS = [
  { id: 'pty', name: '@deepseek-ai/dsh-terminal' },
]

/**
 * 必须在**隔离域内**挂载的工具行。
 *
 * ## 为什么工具必须在域内注册（实测结论）
 *
 * 工具是通过 `ctx.shell` / `ctx.fs` 这两个接缝干活的。而 `agent.ctx` 本身
 * 解析到的是**全局**（本机）实现 —— 实测：远程会话的 `agent.ctx.inject(['shell'])`
 * 拿到的仍是宿主实现（`sandboxMode: 'workspace-write'`）。
 *
 * 所以「让命令落在远程」不能靠禁掉别处的工具，只能靠
 * **在我们自己的隔离域里注册一个工具** —— 它捕获的是域内的 `ctx.shell`。
 *
 * 反过来：不注册的话，远程会话**根本没有能跑命令的工具**
 * （默认预设的 `tool-pwsh` / `tool-bash` 随它自己的 scope 走，不在我们域内）。
 *
 * ## ⚠️ 2026-10-07 补记：这里原先只有 `tool-bash`，是个大缺口
 *
 * 宿主的默认预设 `ptc` 有 **13 行**（persona / agent-instructions / tool-bash /
 * tool-pwsh / **tool-fs** / **tool-fs-search** / tool-jobs / skill-filesystem /
 * tool-skill / command-goal / tool-goal / planning / plan-mode），
 * 而我们只挂了 1 个工具 —— 于是**远程会话里模型只有 bash 和终端**：
 * 不能读文件、不能写文件、不能编辑、不能搜索，也读不到 AGENTS.md。
 *
 * **为什么之前 4 次真机端到端都没发现**：判据一直是
 * 「用 **bash 工具**跑一条命令，看它落在哪边」—— 而 bash 恰好是挂上的那个。
 * 「文件工具没挂」从来没有被触发过。
 *
 * 现在按默认预设对齐。分批的语义见下面两个常量。
 */
export const ISOLATED_TOOL_ROWS = [
  // 命令：`cwd` 必须显式指向**远程根** —— 工具的默认 cwd 是会话工作目录
  // （也就是本机锚点目录），那个路径在远程根本不存在。实测报错是远程 bash 的
  // `cd: <盘符>:\...\anchor: 没有那个文件或目录`。
  { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', withRemoteCwd: true },

  // ⭐ **读文件 / 写文件 / 编辑**。它只注入 `fs`，所以只要挂在域内，
  // 拿到的就是我们的远程实现（`world/fs.js`，含 `writeText` / `editText`
  // 与宿主同一套版本守卫语义）。**这一行是「工作区像在远程一样」的关键。**
  { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },

  // ⚠️ **刻意不挂宿主那个 `tool-fs-search`**。
  //
  // 它用的是**打包在宿主里的 ripgrep 可执行文件** + `subprocess` 接缝
  // （宿主注释：*"never `ctx.shell`"*）—— 也就是说 `glob`/`grep` 会跑在**本机**、
  // 搜的是**本地镜像**：大于 256 KiB 的文件、超过 12 层/2 万条目的部分
  // **根本搜不到**，而且它不会告诉你漏了。
  //
  // 所以 `glob`/`grep` 由我们自己实现（`world/search.js`，在域内用远程的
  // `find` / `grep` 执行）—— 与「工作区在远程」保持一致。
  // 与宿主那份的差异（正则方言、include 大括号、忽略名单）都写在工具描述里，不静默。

  // 后台任务 / 技能 / 目标：与默认预设对齐，纯状态类，不碰目标机器。
  { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
  { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
  { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
  { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
]

/**
 * 「大脑」类行 —— 与默认预设对齐。
 *
 * 这些不碰目标机器（纯提示词 / 纯状态），但**不挂上就等于功能消失**：
 * 远程会话里没有被系统提示词、**AGENTS.md 不会被读**、没有计划模式、没有技能目录。
 *
 * 之所以也要放在预设定里：**预设就是会话的完整插件组合** ——
 * 不挂的行不会从别处「继承」过来。
 */
export const BRAIN_ROWS = [
  {
    id: 'persona',
    name: '@deepseek-ai/dsh-persona',
    config: {
      prefix: 'You are a coding agent powered by the {{model}} model.',
    },
  },
  // ⚠️ 它读 AGENTS.md 用的是 **`node:fs`**（不是 `ctx.fs`），所以读的是**本机**：
  // 会话 cwd = 本机锚点目录 → 命中的是锚点里那份**镜像**（镜像里有远端 AGENTS.md 的副本）。
  // 也就是说「能读到」，但读的是镜像而不是远程 —— 远程改了 AGENTS.md 要等镜像刷新。
  { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
  { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
  {
    // 与默认预设同一个结构：计划模式单独 isolate 一层。
    id: 'planning',
    name: 'cordis:group',
    group: true,
    isolate: { planMode: true },
    config: [
      {
        id: 'plan-mode',
        name: '@deepseek-ai/dsh-plan-mode',
        // ⚠️ `section` **必须**给非空值：宿主实测报
        // `PlanModeConfig needs a non-empty \`section\``，而**一行 broken
        // 会让整个预设激活失败**（我们的 fail-loud 会直接拒绝连接）。
        //
        // 文本逐字取自宿主自己的默认预设 —— 这样远程的计划模式与本地
        // 行为一致。由 `scripts/sync-plan-mode-section.mjs` 生成。
        config: { section: PLAN_MODE_SECTION },
      },
    ],
  },
]

/** 构造一个「显式禁用」的行。宿主审计会跳过 disabled 行（不会判成失败）。 */
function disabledRow(id) {
  return {
    id,
    name: 'cordis:group',
    group: true,
    disabled: true,
    config: [],
  }
}
/**
 * 构造「远程模式」预设定义。
 *
 * 形状与宿主 `agentPresets.register()` 接受的声明一致：
 * 一个 `cordis:group` 行，`isolate` 掉单例服务，组内放我们的 provider。
 *
 * ⚠️ 行里的 `name` **只能是模块 specifier**（包子路径），绝不能是绝对文件路径。
 * 本模块用 `PLUGIN_PACKAGE` 常量拼出来，就是为了让这个约束在代码层面无处可违反。
 *
 * **方案 A（单一远程模式）**：预设 id 固定 {@link PRESET_ID}，provider 行**不再
 * 注入 profileId / remoteRoot / anchorPath** —— 域内 provider 靠「路径路由」
 * （`workspace-routes.js`）动态找到对应的连接，所以一份预设能服务所有远程项目。
 *
 * @param {object} options
 * @param {string} [options.name] 展示名
 * @param {string} [options.description]
 * @param {number} [options.order]
 * @returns {object} 可直接交给 `agentPresets.register()` 的定义
 */
export function buildPresetDefinition(options = {}) {
  const {
    name,
    description,
    order = 500,
  } = options

  const id = PRESET_ID
  const groupId = `${id}-world`

  return {
    id,
    name: name ?? '远程模式',
    description: description ?? '在已连接的远程项目（SSH / WSL / Docker）里工作',
    order,
    plugins: [
      {
        id: groupId,
        // `cordis:group` 是宿主内置的组行；`group: true` 让它成为隔离域。
        name: 'cordis:group',
        group: true,
        isolate: Object.fromEntries(ISOLATED_SERVICES.map((service) => [service, true])),
        config: [
          // `terminals` 服务本体必须在域内挂载 —— 根上下文没有它。
          // 顺序上放最前面：后面的 world-terminal 要注册到它上面。
          ...TERMINAL_SERVICE_ROWS.map((row) => ({ id: row.id, name: row.name })),
          {
            id: `${id}-world-fs`,
            // 模块 specifier —— 不是文件路径。
            // 方案 A：不再注入 profileId/remoteRoot/anchorPath —— 域内 fs 按路径路由。
            name: `${PLUGIN_PACKAGE}/world/fs.js`,
          },
          {
            id: `${id}-world-shell`,
            name: `${PLUGIN_PACKAGE}/world/shell.js`,
            // 方案 A：workdir 翻译时按锚点路由，不再需要固定的 remoteRoot。
          },
          {
            // `glob` / `grep` 的**远程**实现：在域内用远程的 `find` / `grep` 跑
            // （宿主那份用打包在宿主里的 ripgrep + `subprocess`，跑在本机、搜本地镜像）。
            id: `${id}-world-search`,
            name: `${PLUGIN_PACKAGE}/world/search.js`,
            // 方案 A：按搜索路径路由，不再注入固定 remoteRoot。
          },
          {
            id: `${id}-world-terminal`,
            name: `${PLUGIN_PACKAGE}/world/terminal.js`,
            // 终端也必须在**域内**挂载（它注册的后端持域内解析到的 transport）。
            // 方案 A：开终端时按 cwd 路由到对应连接，不再在挂载时绑死。
          },
          // 工具行必须在**域内**注册：它捕获的是域内的 `ctx.fs` / `ctx.shell`（远程实现）。
          // 在域外注册（或用默认预设的行）会解析到全局实现 —— 操作落在本机。
          // 方案 A：不再给 tool-bash 塞 `cwd: remoteRoot` —— 它默认用会话 cwd（锚点），
          // 由 world-shell 翻译成远程根并路由。
          ...ISOLATED_TOOL_ROWS.map((row) => ({
            id: row.id,
            name: row.name,
            ...(row.config === undefined ? {} : { config: row.config }),
          })),
          // 「大脑」类行：提示词 / AGENTS.md / 技能 / 计划模式。
          // 预设是会话的**完整**插件组合 —— 不挂的行不会从别处继承过来。
          ...BRAIN_ROWS.map((row) => ({ ...row })),
        ],
      },
    ],
  }
}

/**
 * 一个预设定义「能不能用」的诊断结果。
 * @typedef {object} PresetDiagnostic
 * @property {string} id
 * @property {boolean} usable
 * @property {string|undefined} broken 宿主给的诊断文本；`usable` 为 true 时为 undefined
 * @property {Array<object>} rows 已挂载的行（用于人工核对）
 */

/**
 * 预设注册表 —— 负责注册、**回读验证**、以及干净的卸载。
 *
 * 存在的核心理由就是**回读验证**：宿主的 `register()` 在激活失败时只写一条 warn，
 * 不会抛错。如果我们注册完就认为「成了」，用户会在界面上看到「已连上远程」，
 * 而 agent 其实在本机跑 —— 这正是参考项目当前的失败状态。
 */
export class PresetRegistry {
  /**
   * @param {object} options
   * @param {object} options.agentPresets 宿主服务 `ctx.agentPresets`
   * @param {(message: string, ...rest: unknown[]) => void} [options.log]
   */
  constructor(options) {
    this.agentPresets = options.agentPresets
    this.log = options.log
    /** @type {Map<string, () => Promise<void>>} id → 注销函数 */
    this.disposers = new Map()
    /** @type {Map<string, PresetDiagnostic>} */
    this.diagnostics = new Map()
  }

  /**
   * 注册一个预设并**立刻回读诊断**。
   *
   * @param {object} definition 见 {@link buildPresetDefinition}
   * @returns {Promise<PresetDiagnostic>}
   * @throws {Error} 注册本身失败（重复 id、空 id、entry list 非法）时抛出 —— 这类失败必须响亮
   */
  async register(definition) {
    if (this.disposers.has(definition.id)) {
      throw new Error(`预设 ${definition.id} 已经注册过（重复注册会让会话行为不确定）`)
    }
    // 宿主的 register() 会 await 激活；激活失败不抛，只记 record.broken。
    const unregister = await this.agentPresets.register(definition)
    this.disposers.set(definition.id, unregister)

    const diagnostic = await this.verify(definition.id)
    if (!diagnostic.usable) {
      // 不静默：注册成功但激活失败，必须让调用方知道。
      this.log?.('[preset] 预设 %s 注册成功但激活失败：%s', definition.id, diagnostic.broken)
    }
    return diagnostic
  }

  /**
   * 幂等注册：预设已注册就**复用**，只回读诊断；未注册才真正注册。
   *
   * 方案 A 需要它：预设收敛成一个「远程模式」，多个连接**共享**这一份 ——
   * 第一个连接注册，后续连接复用（否则会撞 `Duplicate agent preset`）。
   *
   * @param {object} definition 见 {@link buildPresetDefinition}
   * @returns {Promise<PresetDiagnostic>}
   * @throws {Error} 注册失败 / 激活失败（在 {@link assertUsable} 里）时抛出
   */
  async ensureRegistered(definition) {
    if (this.disposers.has(definition.id)) {
      return this.verify(definition.id)
    }
    return this.register(definition)
  }

  /**
   * 回读某个预设的诊断。
   *
   * 这是本项目**唯一**能发现「预设没真的挂上」的手段。
   *
   * @param {string} id
   * @returns {Promise<PresetDiagnostic>}
   */
  async verify(id) {
    const inventory = await this.agentPresets.compositionInventory()
    const row = inventory.find((entry) => entry.id === id)
    /** @type {PresetDiagnostic} */
    const diagnostic = {
      id,
      usable: row !== undefined && row.broken === undefined,
      broken: row?.broken,
      rows: row?.rows ?? [],
      present: row !== undefined,
    }
    this.diagnostics.set(id, diagnostic)
    return diagnostic
  }

  /**
   * 断言某个预设可用；不可用就抛错。
   *
   * **这是「绝不静默降级到本机」的实现点**：会话绑定远程工作区之前必须过这一关，
   * 过不去就拒绝开会话，而不是让它留在本机跑。
   *
   * @param {string} id
   * @throws {Error}
   */
  async assertUsable(id) {
    const diagnostic = await this.verify(id)
    if (!diagnostic.present) {
      throw new Error(`预设 ${id} 不在注册表里 —— 会话不能假装连上了远程`)
    }
    if (!diagnostic.usable) {
      throw new Error(`预设 ${id} 激活失败：${diagnostic.broken ?? '未知原因'} —— 拒绝在本机降级运行`)
    }
    return diagnostic
  }

  /** 注销一个预设。 */
  async unregister(id) {
    const dispose = this.disposers.get(id)
    if (dispose === undefined) return false
    this.disposers.delete(id)
    this.diagnostics.delete(id)
    await dispose()
    return true
  }

  /**
   * 从宿主注册表里**反注册**一个预设（不依赖本实例是否持有 disposer）。
   *
   * 用于清理**上一次进程**注册的遗留预设 —— 那些 disposer 早随进程消失了，
   * 走宿主的 `unregister(id)` 接口才是唯一能它们清掉的路径。
   * 宿主没有这个方法时就放弃清理（返回 false），**不假装成功**。
   *
   * @param {string} id
   * @returns {Promise<boolean>} 是否真的清掉了
   */
  async unregisterFromHost(id) {
    const key = String(id ?? '').trim()
    if (key === '') throw new Error('unregisterFromHost 需要非空的 id')
    const unregister = this.agentPresets?.unregister
    if (typeof unregister !== 'function') return false
    try {
      await unregister.call(this.agentPresets, key)
      this.disposers.delete(key)
      this.diagnostics.delete(key)
      return true
    } catch (error) {
      // 宿主反注册失败（例如 id 已被别人清掉）→ 如实报失败，由调用方决定
      this.log?.('[preset] 宿主反注册 %s 失败：%s', key, error?.message ?? error)
      return false
    }
  }

  /** 注销全部（插件卸载时调用）。 */
  async unregisterAll() {
    const ids = [...this.disposers.keys()]
    const results = await Promise.allSettled(ids.map((id) => this.unregister(id)))
    return { removed: ids.length, failed: results.filter((result) => result.status === 'rejected').length }
  }

  /**
   * **清掉历史遗留的「每项目一个预设」**（方案 A 迁移清理，只跑一次）。
   *
   * 背景：方案 A 之前，每打开一个远程项目就注册一个
   * `multi-remote-<档案>-<哈希>` 预设。这些预设是**常驻**的（只在插件卸载时
   * 才注销），于是升级后在宿主进程里残留下来 —— 模式选择器里出现 N 个
   * 「远程模式 · <项目名>」，用户实测撞见过（2026-10-13）。
   *
   * 判定规则（刻意保守，只删**确定是我们自己生成的旧格式**）：
   *   - id 以 `multi-remote-` 开头（带连字符 → 旧的派生格式）
   *   - 且 id ≠ `multi-remote`（现在的单一预设）
   * 其它插件的预设、宿主的官方预设一律不碰。
   *
   * @returns {Promise<{ removed: string[], failed: number }>}
   */
  async purgeLegacyPresets() {
    const inventory = await this.agentPresets.compositionInventory().catch(() => [])
    const legacy = (Array.isArray(inventory) ? inventory : [])
      .map((row) => row?.id)
      .filter((id) => typeof id === 'string' && id.startsWith(`${PRESET_ID}-`) && id !== PRESET_ID)

    const removed = []
    let failed = 0
    for (const id of legacy) {
      // 自己注册过的走 disposer（干净）；上次进程遗留的走宿主接口
      const ok = this.disposers.has(id)
        ? await this.unregister(id)
        : await this.unregisterFromHost(id)
      if (ok) removed.push(id)
      else failed += 1
    }
    if (removed.length > 0) {
      this.log?.('[preset] 清理了 %d 个历史遗留的每项目预设：%s', removed.length, removed.join(', '))
    }
    return { removed, failed }
  }

  /** 当前已注册的预设 id。 */
  get registeredIds() {
    return [...this.disposers.keys()]
  }
}

/**
 * 检查一个定义是否符合「行 name 必须是模块 specifier」这条硬约束。
 *
 * 单独抽出来是为了能被静态检查与测试复用：绝对路径 / `file:` / 盘符开头的
 * name 会让该行**永不启动**，而宿主只给一个 `never started` 的诊断。
 *
 * @param {object} definition
 * @returns {string[]} 问题列表；空数组表示通过
 */
export function validatePresetDefinition(definition) {
  const problems = []
  if (typeof definition?.id !== 'string' || definition.id.trim() === '') {
    problems.push('id 必须是非空字符串')
  } else if (definition.id.includes('.')) {
    // 参考项目实测：entry id 含点号会导致插件树加载失败
    problems.push(`id 不能含点号：${definition.id}`)
  }
  if (!Array.isArray(definition?.plugins)) {
    problems.push('plugins 必须是数组')
    return problems
  }
  for (const row of definition.plugins) {
    problems.push(...validateRow(row, definition.id))
  }
  return problems
}

/** 递归校验一行（含 group 的 config 子行）。 */
function validateRow(row, presetId) {
  const problems = []
  const where = `${presetId}/${row?.id ?? '(无 id)'}`
  if (typeof row?.id !== 'string' || row.id.trim() === '') problems.push(`${where}: 行 id 必须是非空字符串`)
  else if (row.id.includes('.')) problems.push(`${where}: 行 id 不能含点号`)

  if (typeof row?.name !== 'string' || row.name.trim() === '') {
    problems.push(`${where}: 行 name 必须是非空字符串`)
  } else if (row.name !== 'cordis:group' && !isModuleSpecifier(row.name)) {
    // 这是最重要的一条：绝对路径会被当成 URL 协议，行永不启动。
    problems.push(`${where}: name 必须是模块 specifier（包名或包子路径），得到 ${JSON.stringify(row.name)}`)
  }

  if (Array.isArray(row?.config)) {
    for (const child of row.config) problems.push(...validateRow(child, presetId))
  }
  return problems
}

/**
 * 是否是「可解析的模块 specifier」。
 *
 * 明确拒绝的形态：
 *   - 绝对路径：`/x/y.js`、`<盘符>:/x/y.js`、`<盘符>:\x\y.js`
 *   - URL / 协议：`file:`、`http:` 等（`cordis:group` 这类宿主内置名单独放行）
 *   - 相对路径：`./x.js`、`../x.js`（在预设域里相对谁是不确定的，宿主会当成 URL 解析）
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isModuleSpecifier(name) {
  const value = String(name ?? '').trim()
  if (value === '') return false
  if (value.startsWith('.') || value.startsWith('/') || value.startsWith('\\')) return false
  if (/^[A-Za-z]:[\\/]/.test(value)) return false
  // 允许 scoped 包名里的 `@`，但不允许任何 `scheme:` 形式（`cordis:` 已在调用处单独放行）
  if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(value)) return false
  return true
}
