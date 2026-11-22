# 发布清单（PUBLISH）

发布前逐项确认。勾掉的项已经准备好；未勾的需要你提供信息或在你自己机器上执行。

## 一、还缺的元数据（发布前必须补）

- [ ] `package.json` → `author`：你的名字/昵称，建议带邮箱，如 `"Your Name <you@example.com>"`
- [ ] `package.json` → `repository`：GitHub 仓库地址，如 `{ "type": "git", "url": "git+https://github.com/<you>/dsh-live-dictation.git" }`
- [ ] `package.json` → `homepage`、`bugs.url`：通常就是仓库地址与 `.../issues`
- [ ] `LICENSE` 里的版权署名（现在是 `dsh-live-dictation contributors`，可以换成你的名字）

## 二、已经就绪

- 包名：`dsh-live-dictation`（npm 上未被占用，已核对）
- 版本：`0.1.0`
- `dsh.bundle.patch` → `cordis.patch.yml`（insert 行 id `live-dictation`）
- `dsh.client` 声明 `platform: web`、`immediately: true`、`inject: ["@deepseek-ai/dsh-client-ui-conversation"]`
- `exports` 导出 `./client`、`./locale/*.json`、`./icon`
- `files` 白名单：index.js、client.js、cordis.patch.yml、locale、docs、icon.svg、README.md、LICENSE
- `engines.dsh: ">=0.2.0"`
- `publishConfig.access: "public"`
- `keywords`：含 `deepseek-harness`、`dsh`、`dsh-plugin`、`voice-input`、`push-to-talk` 等市场检索关键词
- 展示信息：`locale/zh.json`、`locale/en.json` 的 `meta.title` / `meta.description`；详情页 `docs/DETAIL.md`（中文）
- 图标：`icon.svg`（64×64，原创）

## 三、发布命令

```powershell
cd C:\Users\10038\Documents\deepseek-harness\default-workspace\plugins\dsh-live-dictation

npm login                 # 需要你的 npm 账号（本机当前未登录：npm whoami → ENEEDAUTH）
npm whoami                # 确认登录身份

npm pack --dry-run        # 检查打进去的文件清单是否符合预期
npm publish               # 公开包（publishConfig.access=public）
```

发布后：

```powershell
npm view dsh-live-dictation version
```

## 四、让市场收录

1. **npm 关键词检索**：发布即生效（`dsh-plugin`、`deepseek-harness` 等关键词）。
2. **GitHub**：把本目录推到一个公开仓库，并给仓库加 topic `dsh-plugin`（`dsh.works`、plugin-radar 等目录按仓库 + topic 索引）。
3. **仓库 README**：已用中文写好，含安装命令与截图位（可以再补一张输入框截图）。
4. 收录一般需要目录抓取周期；`dsh.works` 会核对安装路径与 dsh 版本。

## 五、版本与升级策略

- 修 bug：`0.1.x`
- 新能力（如麦克风选择、流式识别）：`0.2.0`
- 发布后如果改了 `client.js`，用户侧需要重启 DSH 才会加载新版本（客户端模块有缓存）。
