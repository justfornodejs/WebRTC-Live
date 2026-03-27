#!/bin/bash
# ============================================================
# 自签名 SSL 证书生成脚本
#
# 这个证书给 Flask 用（对浏览器提供 HTTPS）
# SRS 不再需要 SSL 证书！
#
# 局域网使用：客户端首次访问 https://服务器IP:5000 时
# 浏览器会提示不受信任，点击「继续」即可，之后不再提示。
# ============================================================

set -e

# 创建 SSL 目录
mkdir -p ssl

# 获取机器的局域网 IP（可手动修改）
LAN_IP=${1:-"192.168.1.100"}

echo "正在为 Flask 生成自签名 SSL 证书..."
echo "服务器 IP: $LAN_IP"

# 生成带 SAN（Subject Alternative Name）的证书
# SAN 确保 Chrome 能正确识别证书的 IP
openssl req -x509 -newkey rsa:2048 \
    -keyout ssl/server.key \
    -out ssl/server.crt \
    -days 365 \
    -nodes \
    -subj "/C=CN/ST=Beijing/L=Beijing/O=WebRTC-Live/CN=$LAN_IP" \
    -addext "subjectAltName=IP:$LAN_IP,IP:127.0.0.1,DNS:localhost"

echo ""
echo "✅ SSL 证书已生成："
echo "   私钥: ssl/server.key"
echo "   证书: ssl/server.crt"
echo "   有效期: 365 天"
echo "   适用 IP: $LAN_IP / 127.0.0.1 / localhost"
echo ""
echo "📌 使用方式："
echo "   bash gen_ssl.sh              # 默认 IP 192.168.1.100"
echo "   bash gen_ssl.sh 10.0.0.50    # 自定义 IP"
echo ""
echo "🌐 客户端浏览器首次访问 https://$LAN_IP:5000 时"
echo "   点击「高级 → 继续前往」即可信任此证书。"
