# GDC iPad 常亮哨兵（PWA）极简部署说明

本目录（`d:\WA\ipad_sentinel\`）为**纯静态零依赖前端 PWA**，不含任何硬编码密钥或账号，所有连接配置均保存在 iPad 本地浏览器 `localStorage` 中。

---

## 3 步极简部署（腾讯云 EdgeOne Pages / Cloudflare Pages）

### 第 1 步：拖拽上传静态目录
- **腾讯云 EdgeOne Pages（国内访问推荐）**：进入控制台 → 新建项目 → 选择 **「直接上传文件 / 文件夹」** → 将整个 `ipad_sentinel` 文件夹直接拖入上传并发布（无需配置构建命令，输出目录留空或填 `/`）。
- **Cloudflare Pages**：进入 Workers & Pages → Create → Pages → **Upload assets（直接上传）** → 将 `ipad_sentinel` 文件夹拖入并点击 **Deploy site**。

### 第 2 步：iPad Safari 添加到主屏幕（全屏常亮）
1. 在 2017 iPad Pro 上打开 **Safari**，访问第 1 步生成的 `https://...` 页面地址。
2. 点击地址栏右侧 **「分享」图标** → 选择 **「添加到主屏幕」** → 从桌面点击 **「GDC 哨兵」** 图标全屏启动。
3. 为确保 24 小时桌面常亮不锁屏，建议在 iPad **「设置 → 显示与亮度 → 自动锁定」** 中设为 **「永不」**，并将屏幕亮度调至舒适低档（页面已内置深色低功耗护屏与每 5 分钟防烧屏微偏移）。

### 第 3 步：一键粘贴配置码上线
1. 点击哨兵右上角 **「连接设置」**。
2. 粘贴以 `GDC_SENTINEL:` 开头的 Base64 配置串，点击 **「解析并保存」**。
3. 左上角显示 **「EMQX 已连接」** 后，点击一次右上角 **「测试 Bark」** 确认手机能收到响铃通知即可投入值守。

---

## 本地浏览器快速预览命令

在 Windows 终端执行（使用系统全局 Python 启动静态服务，不触碰项目 `.venv`）：

```powershell
python -m http.server 8787 -d d:\WA\ipad_sentinel
```

随后在浏览器打开：`http://localhost:8787`
