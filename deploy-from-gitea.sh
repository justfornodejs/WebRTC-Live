#!/bin/bash
# ============================================================
# 从 Gitea 拉取并部署 WebRTC-Live
# ============================================================
#
# 功能描述：自动化从内部 Gitea 拉取代码并部署到生产环境
#
# 使用场景：
#   1. 首次完整部署：执行此脚本
#   2. 更新部署：先在 Gitea 推送代码，再执行此脚本
#
# 部署流程：
#   1. 从 Gitea 检查/克隆仓库
#   2. 同步代码到部署目录
#   3. 重启 Docker 服务
#   4. 验证服务健康状态
#
# 作者：WebRTC-Live Project
# 版本：1.0.0
# 最后修改日期：2026-03-31
# ============================================================

# ============================================================
# 配置变量
# ============================================================
REPO_URL="http://localhost:3000/admin/webrtc-live.git"
REPO_DIR="/data/repos/webrtc-live"
TARGET_DIR="/opt/projects/webrtc-live"
COMPOSE_FILE="docker-compose.yml"

# ============================================================
# 颜色输出
# ============================================================
echo_color() {
    local color=$1
    shift
    printf "\033[0;${color}m%s\033[0m\n" "$@"
}

info() {
    echo_color "36" "ℹ️ $*"
}

success() {
    echo_color "32" "✅ $*"
}

error() {
    echo_color "31" "❌ $*"
}

warning() {
    echo_color "33" "⚠️  $*"
}

# ============================================================
# 主部署流程
# ============================================================

echo "=========================================="
echo "  WebRTC-Live 自动部署"
echo "=========================================="

# 1. 在 Gitea 容器内克隆/拉取代码
info "步骤 1/4: 从 Gitea 拉取代码..."

docker exec paas-gitea bash -c "
    if [ -d \"$REPO_DIR\" ]; then
        echo '仓库已存在，执行拉取...'
        cd \"$REPO_DIR\"
        git fetch origin
        git reset --hard origin/main
    else
        echo '首次克隆仓库...'
        git clone \"$REPO_URL\" \"$REPO_DIR\"
        cd \"$REPO_DIR\"
    fi
    git log -1 --oneline --format='%h - %s (%ar)'
"

if [ $? -ne 0 ]; then
    error "从 Gitea 拉取失败"
    exit 1
fi

success "代码拉取完成"

# 2. 同步代码到部署目录
info "步骤 2/4: 同步代码到部署目录..."

# 复制核心文件（排除 .git 目录）
docker exec paas-gitea bash -c "
    cp -f \"$REPO_DIR/$COMPOSE_FILE\" \"$TARGET_DIR/\"
    cp -f \"$REPO_DIR/Dockerfile\" \"$TARGET_DIR/\"
    cp -rf \"$REPO_DIR/backend\" \"$TARGET_DIR/\"
    cp -rf \"$REPO_DIR/frontend\" \"$TARGET_DIR/\"
    cp -f \"$REPO_DIR/README.md\" \"$TARGET_DIR/\"
"

if [ $? -ne 0 ]; then
    error "文件同步失败"
    exit 1
fi

success "文件同步完成"

# 3. 停止并重启 Docker 服务
info "步骤 3/4: 重启 Docker 服务..."

cd "$TARGET_DIR"

# 停止现有服务
docker compose down

# 构建并启动服务（强制重新构建）
docker compose up -d --build

if [ $? -ne 0 ]; then
    error "服务启动失败"
    exit 1
fi

success "服务启动完成"

# 4. 等待服务就绪
info "步骤 4/4: 验证服务健康状态..."

# 等待容器完全启动
sleep 5

# 检查容器状态
container_status=$(docker ps --filter 'name=webrtc' --format '{{.Status}}' | head -1)
if [ "$container_status" != "Up" ]; then
    error "容器未正常运行: $container_status"
    exit 1
fi

# 健康检查
health_response=$(curl -s --max-time 10 http://127.0.0.1:5000/api/health 2>/dev/null || echo "{}")

srs_status=$(echo "$health_response" | grep -oP '"srs_status":"[^"]*' | grep -oP '[^:]*,' | tr -d ',')
if [ "$srs_status" != "connected" ]; then
    warning "SRS 连接状态: $srs_status"
else
    success "SRS 连接正常"
fi

# ============================================================
# 部署完成
# ============================================================

echo ""
echo "=========================================="
echo "  部署完成"
echo "=========================================="
echo ""
success "WebRTC-Live 服务已成功部署"
echo ""
info "访问方式："
echo "  - 直接访问: http://10.0.6.62:5000"
echo "  - NPM 管理: http://10.0.6.62:81"
echo ""
info "容器状态："
docker ps --filter 'name=webrtc' --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
echo ""
