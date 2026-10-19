# 独立轻量用量插件：实施计划

状态：方案已审核。兼容性验证 G 完成，首批解析修复由 [issue #14](https://github.com/Zigerry/cliproxy-usage/issues/14) 跟踪。

设计约束已明确：发现结果结构、未知数据语义、限流时间含义、UI 原子提交边界和兼容性验证范围；各批修复/功能遵守 issue／分支／PR 流程。

## 1. 目标、边界与当前基线

目标是提高额度数据可信度、刷新可靠性和独立界面可读性，而不是扩展成通用 UI 插件。

必须保持：

- 使用 Pi 公开 API 和 Node 内置能力，不新增运行时依赖。
- 维持独立 `setWidget()` 用量区域和 `ui.custom()` 详情；不调用 `setEditorComponent()` / `setFooter()` 接管宿主组件。
- `/cliproxy-usage` 保持唯一命令入口；沿用 setup、settings、status 等子命令。
- widget 和详情只显示当前模型匹配的账户 provider，不暗示能知道实际请求路由到哪个账户。
- 所有刷新通过 `UsageController` 和 `CoalescingAsyncQueue`；UI 不直接发请求。
- 用量与余额缓存只驻留会话内存；配置按现有路径和权限保存。
- 额度条和颜色表示剩余量：低于 30% 警告、低于 10% 危险。过期、刷新和错误另用文字表示。
- 不记录凭证、原始敏感响应；只按现有 Management API 路径查询官方 provider 用量端点。

不包含：其他插件适配/协议、editor/footer 接管、动画、字体探测、模板引擎、复杂配色设置、用量历史落盘、自动切号、跨 provider 汇总、预览系统和并发调度重构。

已确认基线：

- 项目版本 `0.5.1`，检查时 HEAD 为 `3f4cf3e`，工作区原先干净，分支为 `main`。
- 已运行 `npm test`：55/55；`npm run check`：通过。它们证明现有开发基线通过，不等于真实新版 Pi TUI 已验证。
- 开发 SDK 固定 `0.80.10`；本机 Pi `1.3.0`。两者声明 Node `>=22.19.0`，本机 Node `22.23.2`；CONTRIBUTING 的 Node 20+ 说明需要独立核对修正。
- 本地锁文件开发依赖树有 audit 告警；`npm audit --omit=dev` 为 0。不会执行 `npm audit fix --force`。

## 2. 工作方式与合并门槛

1. 本文先落盘、交 advisor 审核，落实修改后才能开始业务代码。
2. 每批修复/功能建立 issue、聚焦分支和关联 PR；不直接把修复/功能写入 main。不虚构 issue 号或 Git 提交身份。
3. 先补回归测试，再做最小实现；不要把格式整理、SDK 升级和功能改动混成一个提交。
4. 每批完成都运行 `npm test`、`npm run check`、`npm pack --dry-run`，记录实际结果；存在失败或未完成工作不得标完成。
5. 所有网络测试使用 mock fetch、临时配置和合成响应。时间测试使用假时钟或可注入时钟，不依赖真实等待与用户凭证。
6. UI 改动补宽度/语义测试及合成数据截图或文字快照；真实终端 smoke 用隔离 agent 目录，不读取个人配置，不请求真实 provider。
7. 每批保存代码和测试后再交 advisor 完成复核；确认通过后才推进下一批。
8. 本次不发布包、不修改版本号、不自动合并 PR。

## 3. 前置验证 G：Pi 兼容性（独立于功能提交）

优先级：执行前置；依赖：计划获审。

涉及：`package.json`、`package-lock.json`、`.github/workflows/ci.yml`、`CONTRIBUTING.md`、必要的 host API 冒烟测试。

执行：

- 在临时副本或隔离 worktree 中，将必要 Pi SDK 包对齐到当前宿主版本，运行类型检查与测试，避免先修改本分支锁文件。
- 核实 `ctx.mode`、model getter、`setWidget()`、`ui.custom()`、overlay 和 dispose 的公开契约；不使用私有 host 字段或补丁。
- 以现有 `0.80.10` 和当前 `1.3.0` 为候选边界；只有类型检查、测试与隔离 TUI 验证都支持时才承诺兼容范围。旧版本无法支持时明确提高 minimum，不保留未经验证的宽泛承诺。
- 验证范围仅限本插件使用的公开 API；没有完成新版真实 TUI 验证就记录为未验证，不宣称支持。
- 若需要 SDK 升级，独立 chore 提交，说明 Node/SDK 要求；新增功能不顺带升级整棵依赖树，也不因一般依赖告警扩大升级范围。
- CI 的最低/当前版本安装应在隔离环境进行，不能污染确定性 `npm ci` 基线；支持范围和实际验证版本记录在 README/CONTRIBUTING。

完成条件：确定可执行的开发/测试基线、Node 要求和兼容范围；新版类型与真实隔离终端行为均验证，或明确记录 TUI 验证阻塞，不把单元测试替代为实测。

## 4. 批次 A（P0）：额度和窗口解释正确性

依赖：计划获审、issue 和分支就绪、G 的兼容性结论；不依赖状态模型重构。

涉及：`src/parsers.ts`、`src/usage.ts` 中解析 fallback、`test/parsers.test.ts`、`test/usage.test.ts`，必要的 README 说明。

实施：

- Codex 仅使用有效、明确的 `limit_window_seconds` 生成 `5h`、`7d` 或其他真实周期标签；缺失/无效周期使用 `limit`。
- 删除通过 reset 距离或 primary/secondary 位置猜周期的行为；重置时间仍独立保留，用于详情倒计时。
- 明确周期必须为有限正值；reset 日期必须有效。保留现有其他 provider 有依据的周期标签。
- 未提供有效 quota 数字不能当成 used=0；尤其修正 Grok weekly 缺少 `creditUsagePercent` 时默认为 0 的行为。
- 真实 used=0 仍表示剩余 100%，used=100 仍表示剩余 0%；无数字保持未知/无用量窗口，不生成假百分比。
- Kimi 未知 timeUnit 不应当作秒数生成伪精确周期；数字格式和兼容 fallback 的处理在测试中明确。

测试：

- Codex 7d/5h 调换槽位、单窗口、其他明确周期；均按真实 duration 分类。
- 无 duration 但 reset 在 1h、4d 后或已过去，均为 `limit`，保留有效 reset。
- duration 为 0、负值、NaN、Infinity、非数字时不得生成错误周期。
- Grok 缺失/无效 used 不显示 100%；合法 0/100 和余额 0 不被当作缺失。
- Kimi 未知单位不造秒数周期；原有合法单位和数值字符串行为不回退。
- parser 对空/畸形响应不能抛出未捕获错误。

验收：没有周期猜测、没有未知数据冒充完整额度，现有明确窗口和余额功能不回退。

## 5. 批次 B（P0）：账户身份、数据源隔离和迟到请求保护

依赖：A；建议分成 B1 身份回填、B2 生命周期两个原子提交，同一聚焦 issue/PR 只处理缓存隔离。

涉及：`src/types.ts`、`src/usage.ts`、`src/controller.ts`、必要的 `src/refresh.ts`、`index.ts` 接线，以及 usage/controller/refresh 测试。

### B1：身份与缓存边界

- 从发现结果传递 provider 内可靠的 `auth_index`，用于缓存匹配；显示 label 仅用于呈现，不再用于回填。
- 缓存边界包含标准化 Management 数据源、provider 和账户 identity；Management 凭证变化使旧边界失效，但凭证或其派生值不进入对外 ID、日志或视图。
- 如上游没有可靠 identity，不跨刷新回填旧数据，不退回 email/label/数组位置匹配。
- `readAccounts()` 的结果必须显式区分 provider 级发现成功/失败、本次发现的账户集合和账户查询结果，不能仅凭一组带 error 的账户推断发现状态。
- API 账户发现成功时，以本次账户集合为准删除已不存在账户；即使现存账户查询全部失败，也只按稳定 ID 回填这些现存账户，不保留已移除账户。只有发现本身失败才保留旧集合并标注失败。DeepSeek 的发现失败和正常空集合要分别处理。
- 自动检测到 provider 配置文件中的有效 Management URL 改变时，同样切断旧缓存边界；不只覆盖 settings UI 更改。

### B2：生命周期与取消

- Controller 维护 session/config generation，入队请求捕获 generation；注销、切换数据源/凭证、禁用 provider、shutdown/restart 后旧任务失效。
- 单次刷新拥有 AbortController，调用链传递 signal，与已有 10s timeout 合并；mock 不尊重 abort 时仍靠 generation 拒绝迟到结果。
- success、catch、finally、通知、刷新计数、状态清理都验证归属；旧 finally 不能清除新任务的状态。
- 已排队任务在执行前检查版本，不再凭旧 `loaded` settings 发请求；失效任务的 Promise 必须完成，不挂起 waiters。
- 正常 provider 切换可保留同一数据源下其他 provider 会话缓存；绘制时始终根据当前模型过滤。不要把 SDK 动态 getter 误判成旧 model 快照。
- logout 回归覆盖真实 `resetSettings()` 路径，不伪装成 shutdown/start。

测试：

- 同 label 不同 ID，发现顺序改变，至少一个成功一个失败：只能回填本账户旧值。
- 无可靠 ID 时失败不回填；账户替换/删除后旧值不能串到新账户。
- 删除一个账户、发现成功但剩余账户查询全部失败：删除旧账户，仅为现存稳定 ID 回填旧值；与发现失败保留旧集合的行为分开断言。
- Management URL 变更（含自动配置来源）、凭证变更后同名/同 ID 也不复用旧源结果。
- 延迟 fetch 下 logout/reset、禁用、shutdown/start；释放旧响应后无缓存、widget、通知或状态污染。
- 旧请求成功、失败、abort、不尊重 abort；各路径都不会覆盖新 generation。
- pending 请求失效后不发 HTTP，waiters 正常结束，计数不变负，不破坏队列合并规则。

验收：只允许同一有效边界内的同一账户保留缓存；取消与迟到结果不能跨越设置或会话边界。

## 6. 批次 C（P0）：统一状态快照与账户新鲜度

依赖：B。

涉及：`src/types.ts`、`src/controller.ts`、`src/ui.ts`、`src/details-ui.ts`、`index.ts` 的 status 接线；如有需要新增纯派生模块 `src/state.ts` 和 `test/state.test.ts`，不把业务逻辑移入入口文件。

模型原则：

- 账户条目分别保留最近有效额度/余额及其数据时间，以及最近请求的时间/结果（有效、未知、失败）；不能把 HTTP 请求成功等同于获得有效额度。字段数量保持最小，不为此引入复杂状态机。
- provider 保存发现结果、发现错误、最近尝试、完整成功等最小元数据；具体字段以实现前类型设计为准，避免平行 map 与快照各存一份权威状态。
- 从事实派生状态，而不是维护大量可相互矛盾的布尔字段。读取快照不发网络、不落盘、不返回可修改内部对象的引用。
- 最近有效数据时间不因失败或未知响应前进；部分有效结果仅更新对应账户的数据时间。provider 的“完整成功”不因部分成功前进。
- stale 由超出配置新鲜度、刷新失败、已知窗口 reset 到期推导；reset 到期不能自行把额度设为 100%。没有 reset 时间也保留年龄判断。
- 请求成功但响应无可用 quota 字段是未知数据，不是请求失败，也不是空账户；当前额度显示未知，不能继续展示旧额度却推进其数据时间。若内部保留上次有效数据，只能作为明确标注的历史缓存信息，不能充当本次结果。正常发现零账户才是 empty。

显示决策：

| 情况 | widget | 详情 / status |
| --- | --- | --- |
| 模型不支持 / provider 禁用 | 隐藏 | 说明原因 |
| 未配置 URL/密码或密码被拒绝 | 简短需配置提示 | setup 引导，不暴露密码 |
| 首次请求进行中 | 简短加载状态 | 加载状态，无假额度 |
| 成功、有数据 | 额度或余额 | 窗口、reset、最后成功时间 |
| 后台刷新 | 保留现值并标刷新中 | 旧值和刷新中同时可见 |
| 部分失败 | 成功新值 + 失败账户缓存，简短部分失败提示 | 账户级错误与缓存时间 |
| 全失败、有旧数据 | 旧值 + stale | 失败原因与数据年龄 |
| 失败、无旧数据 | 无可用数据/错误提示 | 可理解的错误与重试操作 |
| 成功发现零账户 | 简短无账户状态 | 无账户，不当网络失败 |
| 账户有响应但 quota 未知 | `—` / 无用量窗口 | 明确未知，不显示 100% |

- 额度耗尽显示 `left 0%`，余额零显示实际零值。
- stale/错误用文字，正常额度颜色仍按剩余量；不要把 stale 等同额度不足。
- details 使用同一只读快照，继续即时打开缓存、`r` 刷新与滚动。顶部刷新/错误提示不应因滚动而完全失去可见性。
- 常驻 widget 的年龄状态必须在到期时可更新，不靠任意全局轮询。由 Controller 维护至多一个状态到期唤醒器；到期只重绘，绝不发网络，shutdown/禁用时清理。
- status 子命令复用快照，分别显示最近请求结果、最近有效数据时间、缓存年龄、错误、最早允许刷新时间，以及实际自动刷新计划；不能把限流/退避门槛说成保证执行时间。错误文字不包含凭证或原始 provider body。

测试：上述完整状态矩阵、边界阈值、0/未知区分、有效数据后收到未知响应时显示未知且数据时间不前进、混合失败时间戳、空发现和发现失败、reset 到期、快照不可变、只读状态变化不发 HTTP、计时器清理；widget/details/status 对同一事实描述一致。

验收：三个入口同一权威状态，用户可区分刷新中、过期、部分失败、未知和耗尽；缓存不会被渲染成实时数据。

## 7. 批次 D（P1）：结构化错误、限流等待与简单退避

依赖：B、C。

涉及：`src/usage.ts`、`src/types.ts`、`src/controller.ts`、必要的 `src/refresh.ts`，usage/controller/refresh 测试。

实施：

- 保留 Management HTTP 错误和 api-call 中 provider HTTP 错误的 status、有限类别及 Retry-After 元数据；只读特定安全字段，不缓存原始敏感响应。
- 区分 Management 鉴权拒绝与单个 provider 账户鉴权失败；保留已有密码拒绝后停止自动重试的保护，不能误把 provider 401 当成 Management 密码错误。
- Retry-After 支持秒数和 HTTP 日期；以服务器时间约束为准。不能用本地退避上限截短有效服务器等待；避免超长 setTimeout 溢出，用绝对 nextAllowedAt 再分段唤醒。
- 失败本地退避只针对暂时错误：初值取 refreshMinutes，指数增加到 `max(refreshMinutes, 60 min)` 上限；成功后复位。不要把 unsupported/disabled/未配置状态投入网络重试。
- 首轮用简单的 provider 级冷却，Management 429 使用数据源级冷却，覆盖该数据源的所有 provider；单账户 429 可以保守延后整个 provider，并在状态解释原因，不增加复杂账户调度器。
- `nextAllowedAt` 只表达限流/退避门槛，不保证届时执行请求。自动计划受刷新周期、当前模型和配置约束；status 分别描述最早允许刷新时间与实际自动计划，无自动计划时明确说明。
- 自动 tick、model_select、打开详情和 `r` 都经过同一 eligibility 检查；手动刷新允许绕过缓存新鲜度/本地普通退避，不绕过明确服务器等待。
- 保留现有 coalescing 强化语义；冷却期间重复请求不生成 HTTP 或无限 pending。
- 无凭证、禁用、不支持时不发请求；关 widget 本身不停止已有后台策略（见 E），避免偷偷改变语义。

测试：Management/provider 429、Management 冷却覆盖同源所有 provider、秒数/日期/无效 Retry-After、超长等待、最早允许时间与自动执行计划的区别、手动刷新不绕过服务器限制、允许绕过普通本地退避、退避成功后复位、鉴权错误分层、来源变更清空旧冷却、取消清理、冷却中重复 refresh 不发请求。

验收：刷新节奏可解释、受服务器约束；不加第三方调度依赖、不增后台请求量。

## 8. 批次 E（P2/P3）：独立 UI、窄屏、主题与 widget 开关

依赖：C、D。拆为 E1 窄屏布局、E2 主题配色、E3 `showWidget` 开关三个独立原子提交，不混入 A-D。

涉及：`src/ui.ts`、`src/details-ui.ts`、`src/settings.ts`、`src/settings-ui.ts`、`src/types.ts`、`src/controller.ts`、相应测试和 README。

实施：

- 保留单一 renderer，按宽度逐级降级：优先缩 label，再缩/去 bar，多窗口必要时分行；不能仅截断整张卡片丢掉剩余百分比。
- 30/40/80 列下优先保留窗口标签与 remaining%；极窄不足以容纳一个完整字段时显示安全占位/明确省略，不显示截断数字引起误读。不承诺任意宽度均可同时展示全部信息。余额保留金额和必要币种。
- 中文、emoji、ANSI、长 email 均使用 pi-tui 的可见宽度函数；状态提示也必须安全有界，label/错误中的控制符不能破坏终端布局。
- 去除固定 Claude ANSI 品牌色，默认用当前 Pi 主题 token；额度颜色阈值保持不变。无需字体探测、颜色配置系统、动画或外部皮肤。
- 新增 `showWidget: boolean`，缺失时默认为 true；settings UI 中与 provider 开关分离。关 widget 只隐藏本插件常驻区域，不禁用 provider、不清缓存、不阻止命令查看，也不更改现有后台刷新频率。
- 关闭 widget 时无需为 widget 的年龄重绘保留定时器；详情仍有自己在打开期间的重绘需求；HTTP 刷新仍遵循 D。
- 首轮不新增 density/多皮肤选项；确有必要再单独讨论，不预先增加持久配置。

测试：30/40/80/120 列，中文/长 label、多窗口/余额/错误、remaining 0/100；断言关键标签和完整百分比存在，不只测不超宽。浅色/深色语义主题、主题切换时不缓存旧 ANSI；showWidget 缺省/开关/保存失败回滚/关闭后详情可用且未新增请求。新增配置继续保留未知字段、0600 和原子写入行为。

验收：独立于任何其他插件可用；窄屏核心额度可读，主题配色一致，设置最少；未调用 editor/footer 替换 API，未增加运行时依赖。

## 9. 交付顺序与最终验收

顺序：方案审核 → G → A → B1/B2 → C → D → E。业务修复/功能先建立 issue；兼容性测试和 CI chore 独立交付。

每批用聚焦 issue/PR；A-E 不能以一个超大 PR 交付。后续批次基于前一批已合并基线，或在明确标注依赖的 stacked branch 上开发，不能假设远端已合并。

最终检查：

- [ ] 同名账户、账户删除、来源/凭证变化不会串缓存。
- [ ] 明确周期不误标，未知不冒充 100%，0 额度/余额正常呈现。
- [ ] 加载、空、未知、后台刷新、部分失败、全失败、有/无缓存、需配置、禁用、不支持均有确定行为。
- [ ] logout/reset、设置更改、会话关闭/重启和队列 pending 的迟到响应无副作用。
- [ ] 429 等待与退避可观测，手动刷新不违反服务器冷却。
- [ ] widget/details/status 状态一致，当前模型 provider 范围不回退。
- [ ] 窄屏与主题切换可读，widget 关闭不影响命令。
- [ ] 测试、类型检查、打包和支持版本验证有实际记录。
- [ ] 无新增运行时依赖、其他插件协议、宿主 editor/footer 接管、用量落盘、路由变更或凭证泄露。

## 10. 交付记录

G 完成：两版 SDK 的 55 测试、类型检查和打包通过；Pi 0.80.10 常规 TUI、1.3.0 常规/全屏 TUI 的隔离合成交互通过。细节与覆盖限制见 [兼容性报告](compatibility-report.md)。正式 SDK 依赖与运行时代码未变；独立 chore 分支为 `chore/pi-compatibility`。

A 由 [issue #14](https://github.com/Zigerry/cliproxy-usage/issues/14) 跟踪，使用独立修复分支。B–E 尚待实施。G 的验证结论不代表后续功能已完成。

## 附录：批次 A issue

Title: Fix ambiguous quota windows and unknown usage values

Problem:

- Codex windows without a duration are currently labeled 5h/7d using distance to reset, which cannot prove window length.
- Grok weekly responses without a valid creditUsagePercent currently default to used=0 and may falsely show 100% remaining.
- Kimi unknown time units should not silently acquire a seconds-based duration label.

Expected:

- Only valid explicit durations produce duration labels. Unknown duration uses limit while keeping valid reset timestamps.
- Missing/malformed usage is unknown, never full quota. Real zero values remain valid.
- Keep remaining-quota semantics and current-model provider scope. No new dependency or live provider request.

Scope: src/parsers.ts, parsing fallbacks in src/usage.ts, focused parser/usage tests and relevant documentation. No state/UI redesign in this PR.

Verification: deterministic synthetic response tests; npm test; npm run check; npm pack --dry-run; SDK compatibility conclusion from G recorded separately.

Issue: https://github.com/Zigerry/cliproxy-usage/issues/14

Branch: `fix/14-quota-window-classification`.

Subsequent issues (draft titles only):

- Isolate usage caches by account/source and cancel obsolete refreshes.
- Expose a shared usage snapshot with per-account freshness.
- Respect retry-after and bound transient refresh backoff.
- Preserve quota semantics at narrow widths and add a widget visibility toggle.
