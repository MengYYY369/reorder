# 仓库安全审查报告 — reorder

> 审查日期：2026-10-04（扫描执行：2026-10-03 22:46–22:50，本地）
> 工具：Semgrep 1.179.0（uv 安装）／Gitleaks 8.30.1
> 原始输出：`C:\Projects\security-review\raw\reorder.semgrep.json`、`reorder.gitleaks.json`
> 运行方式：全程本地；Semgrep `--metrics=off`，代码未上传任何外部服务（仅从 Semgrep Registry 下载规则集）

## 一、项目概览（语言/框架/扫描规则集）

| 项 | 值 |
|---|---|
| 仓库 | `C:\Projects\reorder`（origin `https://github.com/MengYYY369/reorder.git`，分支 main；另有 upstream `reorder-js/reorder`） |
| 审查基线 | `c36c69a24b83c18d5a417fa4d279533aeecf7f27`（2026-10-03，"feat(payment-methods): hand the list to the plugin and charge the preferred method"） |
| 拉取情况 | 审查前落后 origin/main 18 个提交，已 `git pull --ff-only` 拉齐。拉取前工作区有一行 `yarn.lock` 本地改动（`react-i18next: 13.5.0`）；经核对该行与 origin/main 版本**完全一致**（冗余改动），用远端版本覆盖后拉取，工作区现已干净 |
| 项目类型 | Medusa v2 订阅/续费插件；包 `@mengyyy369/reorder` 1.10.0；yarn@4.4.1（Yarn Berry，node-modules linker）+ TypeScript；jest（单测/集成）+ Playwright（e2e） |
| 扫描规则集 | `p/nodejs` + `p/typescript` + `p/default` |
| Semgrep 扫描量 | 737 个 git 跟踪文件；执行 255 条规则（加载 1075 条）；解析率 ~100%；12 条命中（2 WARNING/HIGH、2 MEDIUM/HIGH、8 WARNING/LOW） |
| Gitleaks 扫描量 | 419 个提交、8.18 MB；0 条命中 |

**严重度判定标准**：P0 = Semgrep ERROR 级且经核实可实际利用（或 gitleaks 检出真实生产凭证）；P1 = Semgrep WARNING/MEDIUM 级、影响真实构建/发布/运行链路；P2 = Semgrep INFO/低置信、仅测试/脚本/文档代码、经核实为误报。

## 二、高危问题（P0）

**本次扫描未发现 P0 级问题。** Semgrep 无 ERROR 级输出；gitleaks 0 条命中。

## 三、中危问题（P1）

4 条：2 条 GitHub Actions 可变 tag 引用 + 2 条依赖供应链设置缺失。

### P1-1 / P1-2 GitHub Actions 使用可变的 tag 引用（2 处）

- **位置**：`.github/workflows/ci.yml:66`、`.github/workflows/ci.yml:71`
- **规则**：`yaml.github-actions.security.github-actions-mutable-action-tag.github-actions-mutable-action-tag`（CWE-1357 / CWE-353 / OWASP A08）
- **危险代码片段**：
  ```yaml
        steps:
          - uses: actions/checkout@v4

          # Node: package.json engines allows ^20.19.0 || >=22.12.0 and there is no
          # .nvmrc; pinned to 22, the active LTS line the repo is developed on
          # (Node 20 left LTS maintenance in April 2026).
          - uses: actions/setup-node@v4
            with:
              node-version: 22
  ```
- **风险说明**：`v4` 为可变 tag，可被静默重指到恶意提交；CI 中 checkout 的代码会被后续 `corepack yarn build` / 测试直接执行，且工作流包含测试数据库等环境。
- **修复建议**：固定到 40 位 commit SHA（以下 SHA 于 2026-10-03 用 `git ls-remote` 实测为 v4 tag 当前指向）：
  ```yaml
        steps:
          - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4

          - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
            with:
              node-version: 22
  ```

### P1-3 缺少 npm 最小发布年龄（min-release-age）

- **位置**：`.npmrc:1-4`
- **规则**：`package_managers.npm.npm-missing-minimum-release-age.npm-missing-minimum-release-age`（CWE-829 / OWASP A08:2021）
- **危险代码片段**（现行内容）：
  ```ini
  public-hoist-pattern[]=*@medusajs/*
  public-hoist-pattern[]=@tanstack/react-query
  public-hoist-pattern[]=react-i18next
  public-hoist-pattern[]=react-router-dom
  ```
- **风险说明**：缺少"冷却期"；新发布（可能被投毒）的版本会被立即解析安装。
- **修复建议**：追加一行（npm 单位=天，需 npm ≥ 11.10）：
  ```ini
  min-release-age=7
  ```
  注意本仓库实际包管理器是 yarn 4（`.npmrc` 里的 `public-hoist-pattern` 更接近 pnpm/npm 语义），真正的安装侧控制见 P1-4。

### P1-4 Yarn 缺少最小发布年龄门槛（npmMinimalAgeGate）

- **位置**：`.yarnrc.yml:1`
- **规则**：`package_managers.yarn.yarn-missing-minimal-age-gate.yarn-missing-minimal-age-gate`（CWE-829 / OWASP A08:2021）
- **危险代码片段**（现行内容）：
  ```yaml
  nodeLinker: node-modules

  npmScopes:
    mengyyy369:
      npmRegistryServer: "https://npm.pkg.github.com"
  ```
- **风险说明**：Yarn 安装无"冷却期"，新发布/被投毒的包版本会被立即解析。
- **修复建议**：在 `.yarnrc.yml` 增加：
  ```yaml
  npmMinimalAgeGate: "7d"
  ```
  **前提**：该设置需要 Yarn ≥ 4.10，而仓库 `packageManager` 固定为 `yarn@4.4.1`——需先升级（如 `corepack use yarn@4.10.0` 并同步 `packageManager` 字段与 lockfile），否则该项不生效。

## 四、低危/提示（P2）

| # | 位置 | 规则 | 级别/置信度 | 说明 | 判定与建议 |
|---|---|---|---|---|---|
| 1 | `e2e/pages/CancellationCaseDetailPage.ts:120` | `javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp` | WARNING/LOW | `new RegExp(\`^${confirmText}?$\`)`，`confirmText` 是编译期字面量联合类型（`"Apply pause offer"` 等 4 个固定值） | 误报：无用户输入，e2e 测试辅助代码 |
| 2 | `e2e/pages/DunningCaseDetailPage.ts:73` | 同上 | WARNING/LOW | `new RegExp(\`^${title}$\`)`，`title` 由测试用例传入固定标题 | 误报：同上 |
| 3 | `e2e/pages/RenewalDetailPage.ts:42` | 同上 | WARNING/LOW | `new RegExp(subscriptionReference, "i")`，值来自 e2e 夹具 | 误报：同上 |
| 4 | `scripts/assert-package-surface.mjs:252-254` | 同上 | WARNING/LOW | 用 `package.json` 的 `exports` 通配串构造 `RegExp`，用于发布面断言脚本 | 误报：输入是仓库内静态清单，非用户输入 |
| 5 | `integration-tests/http/migrations.spec.ts:148` | `javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal` | WARNING/LOW | `path.join(MODULES_ROOT, moduleName, "migrations")`，`moduleName` 来自仓库内目录枚举 | 误报：测试代码、无外部输入 |
| 6 | `integration-tests/http/migrations.spec.ts:244` | 同上 | WARNING/LOW | `path.join(path.dirname(dir), "models")`，`dir` 来自上一步的固定目录集合 | 误报：同上 |
| 7 | `src/admin/i18n/__tests__/translations.spec.ts:27`（重复输出 2 条） | 同上 | WARNING/LOW | 测试递归遍历 `src/` 目录树校验翻译 key | 误报：同上 |

## 五、硬编码密钥清单（来自 gitleaks）

**未发现任何泄漏**：gitleaks 扫描 419 个提交、8.18 MB，`no leaks found`。

## 六、误报说明

| 条目 | 判定为误报的理由 |
|---|---|
| `detect-non-literal-regexp` ×4 | 全部位于 `e2e/` 与 `scripts/`：输入分别是字面量联合类型、测试标题、e2e 夹具值与仓库内静态 `exports` 清单。这些值不来自运行时用户输入，且 e2e/构建脚本不在生产服务进程内执行，不构成 ReDoS 暴露面。 |
| `path-join-resolve-traversal` ×4 | 全部位于测试代码（`integration-tests/`、`__tests__/`），路径由 `readdirSync`/固定根目录推导，无用户可控输入；即使路径被构造，影响的也只是测试进程读取仓库自身文件。 |

## 七、修复优先级排序与总结

1. **P1-1/1-2（Actions 固定 SHA）**——两行改动，优先做。
2. **P1-4（Yarn 年龄门槛）**——需先把 yarn 从 4.4.1 升到 ≥ 4.10，再在 `.yarnrc.yml` 加 `npmMinimalAgeGate: "7d"`；升级本身建议单独一轮做（涉及 lockfile）。
3. **P1-3（`.npmrc` 加 `min-release-age=7`）**——若安装侧统一走 yarn，可作为兜底。

**总结**：仓库无代码级漏洞、无泄露凭证。12 条 Semgrep 输出中 4 条为真实可修的供应链加固项；其余 8 条（4 条 ReDoS 告警 + 4 条路径遍历告警）全部位于 e2e 测试、单元测试与构建脚本，经核实为误报。
