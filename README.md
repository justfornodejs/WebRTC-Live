# WebRTC Live - 实时直播平台

基于 **WebRTC + SRS** 的浏览器端低延迟（50-300ms）实时直播方案。

## 🏗️ 系统架构

```
推流浏览器 ──WebRTC──➤ SRS 流媒体服务器 ──WebRTC──➤ 拉流浏览器
                          ▲
         Flask 代理 ──────┘ (信令转发/CORS)
```

## 📂 项目结构

```
WebRTC-Live/
├── docker-compose.yml      # SRS Docker 编排
├── srs.conf                # SRS 配置文件
├── gen_ssl.sh              # SSL 证书生成脚本
├── deploy.sh               # 服务器部署脚本
├── DEPLOY.md              # 详细部署文档
├── backend/
│   ├── app.py              # Flask 后端代理
│   ├── requirements.txt    # Python 依赖
│   ├── .env.example        # 环境变量模板
│   └── recordings/         # 录制文件存储目录
├── dvr/                   # SRS 服务端录制目录
└── frontend/
    ├── index.html           # 首页
    ├── publish.html         # 推流页面
    ├── play.html            # 拉流页面
    ├── css/style.css        # 全局样式
    └── js/
        ├── utils.js         # 公共工具
        ├── record.js        # 录制模块
        ├── publish.js       # 推流逻辑
        └── play.js          # 拉流逻辑
```

## 🚀 快速开始

### 前置要求

- Docker & Docker Compose
- Python 3.8+
- OpenSSL（生成 SSL 证书）

### 第一步：生成 SSL 证书

```bash
cd WebRTC-Live
bash gen_ssl.sh
```

> Windows 用户可使用 Git Bash 运行，或手动使用 OpenSSL 生成。

### 第二步：配置 SRS 服务器

编辑 `srs.conf`，将 `candidate` 设为你的服务器 IP：

```
rtc_server {
    candidate   192.168.xxx.xxx;  # 改为服务器实际 IP
}
```

### 第三步：启动 SRS

```bash
docker-compose up -d
```

### 第四步：配置并启动 Flask 后端

```bash
# 复制环境变量配置
cp backend/.env.example backend/.env

# 编辑 .env，修改 SRS 服务器地址
# SRS_API_BASE=https://你的SRS服务器IP:1990
# SRS_STREAM_URL=webrtc://你的SRS服务器IP:1985/live/livestream

# 安装依赖
pip install -r backend/requirements.txt

# 启动服务
python backend/app.py
```

### 第五步：访问

打开浏览器访问 `http://localhost:5000`

- 推流页面：`/publish.html`
- 拉流页面：`/play.html`

## 📋 使用说明

### 推流

1. 进入推流页面，选择推流源（屏幕共享 / 摄像头 / 视频文件）
2. 点击「开始推流」
3. 屏幕共享模式会弹系统权限窗口，选择要共享的屏幕/窗口
4. 推流成功后可在右侧看到分辨率、帧率、码率统计

### 拉流

1. 确保已有推流端在推流
2. 进入拉流页面，点击「开始拉流」
3. 几秒后即可看到低延迟的实时画面

## 🔴 录制功能

项目支持完整的录制功能，包括前端录制和服务端自动录制。

### 前端录制（浏览器端）

**功能特点**：
- 推流端和拉流端都支持录制
- 支持本地下载或服务器上传
- 实时显示录制时长
- WebM/MP4 格式

**使用方法**：
1. 开始推流或拉流后，点击"开始"录制"按钮
2. 选择保存方式：
   - **本地下载**：录制完成后自动下载到本地
   - **服务器存储**：录制完成后自动上传到服务器
3. 录制过程中可实时查看时长
4. 点击"停止录制"结束

**服务器部署**：
```bash
# 使用自动部署脚本
./deploy.sh

# 或手动更新（详见 DEPLOY.md）
git pull
docker-compose restart
# 重启 Flask 后端
pm2 restart webrtc-live
```

### 服务端录制（SRS DVR）

**功能特点**：
- SRS 自动录制所有推流
- 不占用浏览器性能
- FLV 格式存储
- 按时间分割录制文件

**配置**：
- 录制文件存储在 `dvr/` 目录
- 默认单个文件最长 1 小时
- 可调整 `srs.conf` 中的 `dvr_duration` 参数

**查看录制文件**：
```bash
# 查看 DVR 录制
ls -la dvr/

# 或通过 Docker
docker exec srs-server ls -la /usr/local/srs/objs/nginx/nginx/html/dvr/
```

## ⚠️ 注意事项

- WebRTC 在非 localhost 下**必须使用 HTTPS**（浏览器安全策略）
- SRS `candidate` 必须设为客户端可访问的 IP 地址
- 自签名证书在 Chrome 中需要手动信任（访问 `https://SRS_IP:1990` 并点击继续）
- 推荐使用 Chrome 或 Edge 浏览器

## 🔧 技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| 流媒体服务器 | SRS v5 | 开源高性能流媒体服务器 |
| 信令传输 | Flask | Python Web 框架做信令代理 |
| 实时传输 | WebRTC | 浏览器原生低延迟协议 |
| 视频编码 | H.264 | SRS 兼容性最佳的编码 |
| 容器化 | Docker | SRS 服务一键部署 |
