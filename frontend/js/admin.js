/**
 * WebRTC-Live 管理看板逻辑
 * 
 * 功能：
 *  1. 周期性获取服务端聚合统计数据 (/api/admin/stats)
 *  2. 动态渲染流列表、推流端 IP、以及订阅者详情
 *  3. 实时汇总在线流数量和总客户端数
 */

document.addEventListener("DOMContentLoaded", () => {
    const streamList = document.getElementById("streamList");
    const totalStreamsEl = document.getElementById("totalStreams");
    const totalClientsEl = document.getElementById("totalClients");
    const serverTimeEl = document.getElementById("serverTimeText");

    /**
     * 获取并更新数据
     */
    async function updateStats() {
        try {
            const response = await fetch("/api/admin/stats");
            const data = await response.json();

            if (data.code === 0) {
                renderSummary(data.summary);
                renderStreamList(data.streams);
            } else {
                console.error("获取统计数据失败:", data.error);
            }
        } catch (error) {
            console.error("请求看板数据异常:", error);
        }
    }

    /**
     * 渲染汇总信息
     */
    function renderSummary(summary) {
        totalStreamsEl.textContent = summary.total_streams;
        totalClientsEl.textContent = summary.total_clients;
        serverTimeEl.textContent = `最后更新时间: ${summary.server_time}`;
        
        // 简单负载判断
        const loadEl = document.getElementById("serverLoad");
        if (summary.total_clients > 50) {
            loadEl.textContent = "High Load";
            loadEl.style.color = "var(--accent-rose)";
        } else {
            loadEl.textContent = "Stable";
            loadEl.style.color = "var(--accent-emerald)";
        }
    }

    /**
     * 渲染流列表表格
     */
    function renderStreamList(streams) {
        if (!streams || streams.length === 0) {
            streamList.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:3rem; color:var(--text-muted);">当前无活跃推流</td></tr>`;
            return;
        }

        let html = "";
        streams.forEach(stream => {
            const statusBadge = stream.has_publisher 
                ? `<span class="badge badge-success">推流中</span>` 
                : `<span class="badge badge-warn">无源 (等待中)</span>`;
            
            const publisherInfo = stream.publisher_ip !== "N/A" 
                ? `<div class="publisher-info"><span>🏠</span> ${stream.publisher_ip}</div>`
                : `<span style="color:var(--text-muted)">-</span>`;

            // 处理订阅者标签
            let subscribersHtml = "";
            if (stream.subscribers && stream.subscribers.length > 0) {
                subscribersHtml = `<div class="client-list">`;
                stream.subscribers.forEach(s => {
                    subscribersHtml += `<span class="client-tag" title="ID: ${s.id}">${s.ip}</span>`;
                });
                subscribersHtml += `</div>`;
            } else {
                subscribersHtml = `<span style="color:var(--text-muted)">暂无观众</span>`;
            }

            html += `
                <tr class="stream-row">
                    <td>
                        <div style="font-weight:600; color:var(--text-primary)">${stream.name}</div>
                        <div style="font-size:0.75rem; color:var(--text-muted)">ID: ${stream.id}</div>
                    </td>
                    <td>${statusBadge}</td>
                    <td style="font-family:var(--font-mono)">${stream.bitrate_kbps} kbps</td>
                    <td>
                        <strong style="color:var(--primary-start)">${stream.clients_count}</strong>
                    </td>
                    <td>
                        <div style="font-size:0.8rem; margin-bottom:4px; font-weight:600">推流源: ${publisherInfo}</div>
                        <div style="font-size:0.75rem; color:var(--text-muted)">正在观看:</div>
                        ${subscribersHtml}
                    </td>
                </tr>
            `;
        });
        streamList.innerHTML = html;
    }

    // 初始化运行
    updateStats();

    // 每 3 秒刷新一次
    const interval = setInterval(updateStats, 3000);

    // 页面卸载时清理定时器
    window.addEventListener("beforeunload", () => {
        clearInterval(interval);
    });
});
