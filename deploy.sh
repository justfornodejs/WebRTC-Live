#!/bin/bash
# WebRTC-Live 服务器部署脚本
# 用法: ./deploy.sh

set -e

echo "============================================================"
echo "WebRTC-Live 服务器部署脚本"
echo "============================================================"

# 项目路径（请根据实际情况修改）
PROJECT_DIR="/path/to/WebRTC-Live"

# 检查项目目录是否存在
if [ ! -d "$PROJECT_DIR" ]; then
    echo "错误: 项目目录不存在: $PROJECT_DIR"
    echo "请修改脚本中的 PROJECT_DIR 变量为实际项目路径"
    exit 1
fi

echo "项目目录: $PROJECT_DIR"

# 进入项目目录
cd "$PROJECT_DIR"

# 显示当前 Git 状态
echo ""
echo "当前 Git 状态:"
git status --short

# 拉取最新代码
echo ""
echo "正在拉取最新代码..."
git pull

# 创建必要目录
echo ""
echo "创建必要目录..."
mkdir -p backend/recordings
mkdir -p dvr
echo "✓ 目录创建完成"

# 重启 SRS 服务
echo ""
echo "重启 SRS 服务..."
docker-compose restart
echo "✓ SRS 服务已重启"

# 重启 Flask 后端
echo ""
echo "重启 Flask 后端..."
if command -v pm2 &> /dev/null; then
    # 使用 PM2 管理进程
    if pm2 list | grep -q "webrtc-live"; then
        pm2 restart webrtc-live
    else
        echo "注意: 未找到 webrtc-live 进程，请先启动:"
        echo "pm2 start backend/app.py --name webrtc-live"
    fi
    echo "✓ Flask 后端已重启 (PM2)"
elif systemctl is-active --quiet webrtc-live; then
    # 使用 systemd 管理服务
    sudo systemctl restart webrtc-live
    echo "✓ Flask 后端已重启 (systemd)"
else
    # 手动运行的进程
    pkill -f "python.*app.py" || true
    nohup python backend/app.py > logs/app.log 2>&1 &
    echo "✓ Flask 后端已重启 (手动)"
fi

# 检查服务状态
echo ""
echo "============================================================"
echo "服务状态检查"
echo "============================================================"

# SRS 状态
if docker-compose ps | grep -q "Up"; then
    echo "✓ SRS 服务: 运行中"
else
    echo "✗ SRS 服务: 未运行"
fi

# Flask 后端状态
if command -v pm2 &> /dev/null; then
    pm2 status webrtc-live
elif systemctl is-active --quiet webrtc-live; then
    echo "✓ Flask 后端: 运行中 (systemd)"
else
    if pgrep -f "python.*app.py" > /dev/null; then
        echo "✓ Flask 后端: 运行中 (手动)"
    else
        echo "✗ Flask 后端: 未运行"
    fi
fi

echo ""
echo "============================================================"
echo "部署完成！"
echo "============================================================"
echo ""
echo "请访问以下地址验证录制功能:"
echo "  - 推流页面的录制面板: http://your-server:5000/publish.html"
echo "  - 拉流页面的录制面板: http://your-server:5000/play.html"
