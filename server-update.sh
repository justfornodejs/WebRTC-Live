#!/bin/bash
# WebRTC-Live 服务器更新脚本
# 此脚本在服务器上运行

set -e

echo "============================================================"
echo "WebRTC-Live 服务器更新脚本"
echo "============================================================"

PROJECT_DIR="/opt/WebRTC-Live"

# 检查项目目录
if [ ! -d "$PROJECT_DIR" ]; then
    echo "错误: 项目目录不存在: $PROJECT_DIR"
    exit 1
fi

cd "$PROJECT_DIR"

echo "当前目录: $(pwd)"
echo ""

# 显示当前 Git 状态
echo "当前 Git 状态:"
git status --short
echo ""

# 拉取最新代码
echo "正在拉取最新代码..."
git pull
echo "✓ 代码已更新"
echo ""

# 创建必要目录
echo "创建必要目录..."
mkdir -p backend/recordings
mkdir -p dvr
echo "✓ 目录创建完成"
echo ""

# 更新部署脚本中的项目路径
echo "更新 deploy.sh 中的项目路径..."
sed -i "s|PROJECT_DIR=.*|PROJECT_DIR=\"$PROJECT_DIR\"|" deploy.sh
echo "✓ 部署脚本已更新"
echo ""

# 重启 SRS 服务
echo "重启 SRS 服务..."
docker-compose restart
echo "✓ SRS 服务已重启"
echo ""

# 重启 Flask 后端
echo "重启 Flask 后端..."
if command -v pm2 &> /dev/null; then
    # 使用 PM2 管理进程
    if pm2 list | grep -q "webrtc-live"; then
        echo "使用 PM2 重启后端..."
        pm2 restart webrtc-live
    else
        echo "未找到 webrtc-live 进程，启动新进程..."
        cd backend
        pm2 start app.py --name webrtc-live
        cd ..
    fi
    echo "✓ Flask 后端已重启 (PM2)"
elif systemctl is-active --quiet webrtc-live; then
    # 使用 systemd 管理服务
    sudo systemctl restart webrtc-live
    echo "✓ Flask 后端已重启 (systemd)"
else
    # 手动运行的进程
    echo "停止旧的进程..."
    pkill -f "python.*app.py" || true
    sleep 2

    echo "启动新进程..."
    mkdir -p logs
    nohup python3 backend/app.py > logs/app.log 2>&1 &
    echo "✓ Flask 后端已重启 (手动)"
fi
echo ""

# 等待服务启动
echo "等待服务启动..."
sleep 5
echo ""

# 检查服务状态
echo "============================================================"
echo "服务状态检查"
echo "============================================================"

# SRS 状态
echo ""
echo "SRS 服务状态:"
docker-compose ps

# Flask 后端状态
echo ""
echo "Flask 后端状态:"
if command -v pm2 &> /dev/null; then
    pm2 status webrtc-live
elif systemctl is-active --quiet webrtc-live; then
    sudo systemctl status webrtc-live
else
    if pgrep -f "python.*app.py" > /dev/null; then
        echo "✓ Flask 后端: 运行中 (手动)"
        ps aux | grep python | grep app.py
    else
        echo "✗ Flask 后端: 未运行"
    fi
fi

echo ""
echo "============================================================"
echo "更新完成！"
echo "============================================================"
echo ""
echo "请访问以下地址验证录制功能:"
echo "  推流页面: http://10.0.6.62:5000/publish.html"
echo "  拉流页面: http://10.0.6.62:5000/play.html"
echo ""
echo "测试 API 接口:"
echo "  健康检查: curl http://10.0.6.62:5000/api/health"
echo "  录制列表: curl http://10.0.6.62:5000/api/recordings/list"
