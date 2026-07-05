let currentData = null;
let simulation = null;
let svg = null;
let graphGroup = null;
let zoom = null;
let globalUptimeInterval = null;
let clusterGroups = null;

// ============================================================
// ===== مدیریت نام‌های سفارشی =====
// ============================================================
const CUSTOM_NAMES_KEY = 'device_custom_names';

function getCustomNames() {
    try {
        const data = localStorage.getItem(CUSTOM_NAMES_KEY);
        return data ? JSON.parse(data) : {};
    } catch { return {}; }
}

function saveCustomName(ip, name) {
    const names = getCustomNames();
    if (name && name.trim() !== '' && name !== ip) {
        names[ip] = name.trim();
    } else {
        delete names[ip];
    }
    localStorage.setItem(CUSTOM_NAMES_KEY, JSON.stringify(names));
}

function getCustomName(ip) {
    const names = getCustomNames();
    return names[ip] || null;
}

function applyCustomNamesToNodes(nodes) {
    if (!nodes) return;
    nodes.forEach(node => {
        const customName = getCustomName(node.ip || node.id);
        if (customName) {
            node.customName = customName;
        } else {
            node.customName = null;
        }
    });
}

// ============================================================
// ===== ذخیره‌سازی موقعیت گره‌ها =====
// ============================================================
const POSITIONS_KEY = 'graph_node_positions';

function saveNodePositions(nodes) {
    if (!nodes) return;
    const positions = {};
    nodes.forEach(node => {
        const id = node.id || node.ip || node.index;
        if (id && node.x !== undefined && node.y !== undefined) {
            positions[id] = { x: node.x, y: node.y };
        }
    });
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
}

function loadNodePositions(nodes) {
    if (!nodes) return;
    try {
        const data = localStorage.getItem(POSITIONS_KEY);
        if (!data) return;
        const positions = JSON.parse(data);
        nodes.forEach(node => {
            const id = node.id || node.ip || node.index;
            if (id && positions[id]) {
                node.x = positions[id].x;
                node.y = positions[id].y;
                node.fx = positions[id].x;
                node.fy = positions[id].y;
            }
        });
    } catch (e) {
        console.debug('Failed to load positions:', e);
    }
}

function clearNodePositions() {
    localStorage.removeItem(POSITIONS_KEY);
    setStatus('🗑️ Node positions cleared');
}

// ============================================================
// ===== مدیریت لینک‌های دستی =====
// ============================================================
const MANUAL_LINKS_KEY = 'graph_manual_links';
let linkSelectionMode = false;
let selectedNodeForLink = null;

function getManualLinks() {
    try {
        const data = localStorage.getItem(MANUAL_LINKS_KEY);
        return data ? JSON.parse(data) : [];
    } catch { return []; }
}

function saveManualLink(sourceId, targetId) {
    const links = getManualLinks();
    const exists = links.some(l => 
        (l.source === sourceId && l.target === targetId) || 
        (l.source === targetId && l.target === sourceId)
    );
    if (!exists && sourceId !== targetId) {
        links.push({ source: sourceId, target: targetId, type: 'manual' });
        localStorage.setItem(MANUAL_LINKS_KEY, JSON.stringify(links));
        return true;
    }
    return false;
}

function deleteManualLink(sourceId, targetId) {
    let links = getManualLinks();
    links = links.filter(l => 
        !(l.source === sourceId && l.target === targetId) &&
        !(l.source === targetId && l.target === sourceId)
    );
    localStorage.setItem(MANUAL_LINKS_KEY, JSON.stringify(links));
}

function loadManualLinks(nodes, existingLinks) {
    const manualLinks = getManualLinks();
    const nodeIds = new Set(nodes.map(n => n.id || n.ip));
    
    manualLinks.forEach(ml => {
        if (nodeIds.has(ml.source) && nodeIds.has(ml.target)) {
            const exists = existingLinks.some(l => 
                (l.source === ml.source && l.target === ml.target) ||
                (l.source === ml.target && l.target === ml.source)
            );
            if (!exists) {
                existingLinks.push({ 
                    source: ml.source, 
                    target: ml.target, 
                    type: 'manual',
                    strength: 0.5
                });
            }
        }
    });
    return existingLinks;
}

// ============================================================
// ===== تابع فرمت‌دهی Uptime =====
// ============================================================
function formatUptime(timestamp) {
    if (!timestamp) return 'N/A';
    const now = Date.now();
    const diff = now - timestamp;
    if (diff < 0) return 'N/A';
    
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

// ============================================================
// ===== تاریخچه اسکن =====
// ============================================================
const HISTORY_KEY = 'network_scan_history';
const MAX_HISTORY = 20;

function getHistory() {
    try {
        const data = localStorage.getItem(HISTORY_KEY);
        return data ? JSON.parse(data) : [];
    } catch { return []; }
}

function saveToHistory(scanData) {
    if (!scanData || !scanData.nodes) return;
    const history = getHistory();
    const entry = {
        id: Date.now(),
        timestamp: new Date().toLocaleString(),
        range: scanData.scanRange?.startIP || scanData.scanRange?.baseIP || 'Unknown',
        nodeCount: scanData.nodes.length,
        data: scanData
    };
    history.unshift(entry);
    if (history.length > MAX_HISTORY) history.pop();
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    renderHistoryList();
}

function loadFromHistory(entry) {
    if (!entry || !entry.data) return;
    currentData = entry.data;
    applyCustomNamesToNodes(currentData.nodes);
    createGraph(currentData);
    setStatus(`📂 Loaded scan from ${entry.timestamp} (${entry.nodeCount} devices)`);
    document.getElementById('history-panel').style.display = 'none';
    document.getElementById('history-toggle').textContent = '📂 History';
}

function clearHistory() {
    if (!confirm('Delete all saved scans?')) return;
    localStorage.removeItem(HISTORY_KEY);
    renderHistoryList();
    setStatus('🗑️ History cleared');
}

function renderHistoryList() {
    const history = getHistory();
    const list = document.getElementById('history-list');
    const count = document.getElementById('history-count');
    if (!list) return;
    
    if (history.length === 0) {
        list.innerHTML = '<div style="color: #484f58; padding: 8px 0; font-style: italic; text-align: center;">No saved scans</div>';
        if (count) count.textContent = '0';
        return;
    }
    
    list.innerHTML = history.map((entry) => `
        <div class="history-item">
            <div class="history-item-info">
                <span class="history-item-range">📡 ${entry.range}</span>
                <span class="history-item-time">${entry.timestamp}</span>
                <span class="history-item-count">${entry.nodeCount} devices</span>
            </div>
            <div class="history-item-actions">
                <button class="history-load-btn" data-id="${entry.id}">Load</button>
                <button class="history-delete-btn" data-id="${entry.id}">✕</button>
            </div>
        </div>
    `).join('');
    
    if (count) count.textContent = history.length;
    
    list.querySelectorAll('.history-load-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const id = parseInt(this.dataset.id);
            const entry = getHistory().find(e => e.id === id);
            if (entry) loadFromHistory(entry);
        });
    });
    list.querySelectorAll('.history-delete-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const id = parseInt(this.dataset.id);
            let history = getHistory();
            history = history.filter(e => e.id !== id);
            localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
            renderHistoryList();
            setStatus('🗑️ Scan deleted');
        });
    });
}

function toggleHistoryPanel() {
    const panel = document.getElementById('history-panel');
    const toggle = document.getElementById('history-toggle');
    if (panel.style.display === 'block') {
        panel.style.display = 'none';
        toggle.textContent = '📂 History';
    } else {
        panel.style.display = 'block';
        toggle.textContent = '📂 Hide History';
        renderHistoryList();
    }
}

// ============================================================
// ===== زیرشبکه‌ها (Clustering) =====
// ============================================================
function drawSubnetClusters(nodes, graphGroup) {
    graphGroup.selectAll('.cluster-group').remove();
    if (!nodes || nodes.length === 0) return;
    
    const subnetMap = new Map();
    nodes.forEach(node => {
        const subnet = node.subnet || 'unknown';
        if (!subnetMap.has(subnet)) subnetMap.set(subnet, []);
        subnetMap.get(subnet).push(node);
    });
    
    const clusters = Array.from(subnetMap.entries())
        .filter(([subnet, devices]) => devices.length > 1);
    
    if (clusters.length === 0) return;
    
    clusterGroups = [];
    const colors = ['#3fb950', '#58a6ff', '#d29922', '#f0883e', '#a371f7', '#f85149', '#79c0ff'];
    
    clusters.forEach(([subnet, devices]) => {
        const positions = devices.map(d => ({ x: d.x || 0, y: d.y || 0 }));
        const centerX = positions.reduce((s, p) => s + p.x, 0) / positions.length;
        const centerY = positions.reduce((s, p) => s + p.y, 0) / positions.length;
        const maxDist = Math.max(120, positions.reduce((max, p) => {
            const dist = Math.sqrt((p.x - centerX)**2 + (p.y - centerY)**2);
            return Math.max(max, dist);
        }, 0) + 60);
        const colorIndex = Array.from(subnetMap.keys()).indexOf(subnet) % colors.length;
        const color = colors[colorIndex];
        
        const clusterGroup = graphGroup.append('g')
            .attr('class', 'cluster-group')
            .attr('data-subnet', subnet);
        
        clusterGroup.append('ellipse')
            .attr('cx', 0).attr('cy', 0)
            .attr('rx', maxDist * 1.2).attr('ry', maxDist * 0.9)
            .attr('fill', color).attr('fill-opacity', 0.08)
            .attr('stroke', color).attr('stroke-width', 1.5)
            .attr('stroke-dasharray', '6,4').attr('opacity', 0.7)
            .style('pointer-events', 'none');
        
        clusterGroup.append('text')
            .attr('x', 0).attr('y', -maxDist * 0.9 - 12)
            .attr('text-anchor', 'middle')
            .attr('fill', color)
            .attr('font-size', '11px').attr('font-family', 'monospace')
            .attr('font-weight', 'bold').attr('opacity', 0.9)
            .style('filter', 'url(#text-shadow)')
            .style('pointer-events', 'none')
            .text(subnet !== 'unknown' ? subnet : 'Unknown Subnet');
        
        clusterGroups.push({
            group: clusterGroup,
            devices: devices,
            centerX: centerX,
            centerY: centerY,
            maxDist: maxDist,
            subnet: subnet
        });
    });
}

function updateClusterPositions() {
    if (!clusterGroups) return;
    clusterGroups.forEach(cluster => {
        const positions = cluster.devices.map(d => ({ x: d.x || 0, y: d.y || 0 }));
        const centerX = positions.reduce((s, p) => s + p.x, 0) / positions.length;
        const centerY = positions.reduce((s, p) => s + p.y, 0) / positions.length;
        const maxDist = Math.max(120, positions.reduce((max, p) => {
            const dist = Math.sqrt((p.x - centerX)**2 + (p.y - centerY)**2);
            return Math.max(max, dist);
        }, 0) + 60);
        cluster.group.attr('transform', `translate(${centerX},${centerY})`);
        cluster.group.select('ellipse')
            .attr('rx', maxDist * 1.2).attr('ry', maxDist * 0.9);
        cluster.group.select('text')
            .attr('y', -maxDist * 0.9 - 12);
    });
}

// ============================================================
// ===== Export Functions =====
// ============================================================
function exportJSON() {
    if (!currentData) { setStatus('❌ No data to export. Please scan first.'); return; }
    const dataStr = JSON.stringify(currentData, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `network_scan_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatus('✅ JSON exported successfully!');
}

function exportCSV() {
    if (!currentData || !currentData.nodes) { setStatus('❌ No data to export. Please scan first.'); return; }
    const headers = ['IP', 'MAC', 'Hostname', 'Vendor', 'Category', 'Status', 'Latency (ms)', 'Gateway', 'Open Ports', 'Uptime'];
    const rows = [headers.join(',')];
    currentData.nodes.forEach(node => {
        const status = node.isAlive ? 'Online' : 'Offline';
        const uptime = (node.isAlive && node.firstSeen) ? formatUptime(node.firstSeen) : 'N/A';
        const ports = (node.ports && node.ports.length > 0) ? node.ports.join(';') : 'None';
        const vendor = node.manufacturer?.companyName || 'Unknown';
        const displayName = node.customName || node.hostname || node.name || 'N/A';
        const row = [
            node.ip || node.id || 'N/A',
            node.mac || 'Unknown',
            displayName,
            vendor,
            node.category || 'Unknown',
            status,
            node.latency !== undefined ? node.latency : 'N/A',
            node.isGateway ? 'Yes' : 'No',
            ports,
            uptime
        ];
        rows.push(row.join(','));
    });
    const csvStr = rows.join('\n');
    const blob = new Blob([csvStr], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `network_scan_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatus('✅ CSV exported successfully!');
}

function exportPNG() {
    if (!currentData) { setStatus('❌ No graph to export. Please scan first.'); return; }
    if (typeof html2canvas === 'undefined') { setStatus('❌ html2canvas library not loaded.'); return; }
    const graphElement = document.getElementById('graph');
    if (!graphElement) { setStatus('❌ Graph element not found.'); return; }
    setStatus('📸 Generating image...', true);
    html2canvas(graphElement, {
        backgroundColor: '#0d1117',
        scale: 2,
        useCORS: true,
        logging: false
    }).then(canvas => {
        const link = document.createElement('a');
        link.download = `network_topology_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
        setStatus('✅ PNG exported successfully!');
    }).catch(err => {
        console.error('PNG export error:', err);
        setStatus('❌ Failed to export PNG: ' + err.message);
    });
}

// ===== Export PDF =====
async function exportPDF() {
    if (!currentData || !currentData.nodes) {
        setStatus('❌ No data to export. Please scan first.');
        return;
    }

    if (typeof window.jspdf === 'undefined' || typeof window.jspdf.autoTable === 'undefined') {
        setStatus('❌ PDF library not loaded. Please refresh the page.');
        return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF('l', 'mm', 'a4');
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();

    doc.setFontSize(18);
    doc.setTextColor(40, 40, 50);
    doc.text('Network Scan Report', pageWidth / 2, 20, { align: 'center' });

    doc.setFontSize(11);
    doc.setTextColor(60, 60, 80);
    const totalDevices = currentData.nodes.length;
    const onlineDevices = currentData.nodes.filter(n => n.isAlive).length;
    const offlineDevices = totalDevices - onlineDevices;
    const avgLatency = currentData.nodes
        .filter(n => n.latency !== undefined && n.latency !== null && n.isAlive)
        .reduce((sum, n) => sum + n.latency, 0) / (currentData.nodes.filter(n => n.isAlive && n.latency !== undefined).length || 1);

    const infoLines = [
        `📅 Report Date: ${new Date().toLocaleString()}`,
        `📡 Total Devices: ${totalDevices}`,
        `🟢 Online: ${onlineDevices}`,
        `🔴 Offline: ${offlineDevices}`,
        `⏱️ Average Latency: ${Math.round(avgLatency)} ms`
    ];
    let yPos = 30;
    infoLines.forEach(line => {
        doc.text(line, 20, yPos);
        yPos += 7;
    });

    const tableHeaders = ['IP', 'MAC', 'Hostname', 'Vendor', 'Category', 'Status', 'Latency', 'Ports'];
    const tableRows = currentData.nodes.map(node => [
        node.ip || node.id || 'N/A',
        node.mac || 'Unknown',
        node.customName || node.hostname || node.name || 'N/A',
        node.manufacturer?.companyName || 'Unknown',
        node.category || 'Unknown',
        node.isAlive ? 'Online' : 'Offline',
        node.latency !== undefined && node.latency !== null ? `${node.latency}ms` : 'N/A',
        (node.ports && node.ports.length > 0) ? node.ports.join(', ') : 'None'
    ]);

    let startY = yPos;
    let rowsToPrint = tableRows;
    while (rowsToPrint.length > 0) {
        const remainingHeight = pageHeight - startY - 15;
        const rowHeight = 7;
        const headerHeight = 10;
        const maxRows = Math.floor((remainingHeight - headerHeight) / rowHeight);
        const chunk = rowsToPrint.slice(0, maxRows);
        rowsToPrint = rowsToPrint.slice(maxRows);

        doc.autoTable({
            head: [tableHeaders],
            body: chunk,
            startY: startY,
            theme: 'grid',
            styles: { fontSize: 8, cellPadding: 2, lineColor: [180, 180, 190], lineWidth: 0.1 },
            headStyles: { fillColor: [40, 40, 50], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9 },
            alternateRowStyles: { fillColor: [245, 245, 250] },
            didDrawPage: function(data) {
                doc.setFontSize(8);
                doc.setTextColor(150);
                doc.text(`Page ${data.pageNumber}`, pageWidth - 20, pageHeight - 10);
            }
        });

        if (rowsToPrint.length > 0) {
            doc.addPage();
            startY = 20;
            doc.setFontSize(14);
            doc.setTextColor(40, 40, 50);
            doc.text('Network Scan Report (continued)', pageWidth / 2, 15, { align: 'center' });
            startY = 25;
        }
    }

    const graphElement = document.getElementById('graph');
    if (graphElement && typeof html2canvas !== 'undefined') {
        try {
            doc.addPage();
            doc.setFontSize(14);
            doc.setTextColor(40, 40, 50);
            doc.text('Network Topology', pageWidth / 2, 15, { align: 'center' });

            const canvas = await html2canvas(graphElement, {
                backgroundColor: '#0d1117',
                scale: 1.5,
                useCORS: true,
                logging: false
            });
            const imgData = canvas.toDataURL('image/png');
            const imgWidth = pageWidth - 40;
            const imgHeight = (canvas.height / canvas.width) * imgWidth;
            const maxImgHeight = pageHeight - 40;
            const finalHeight = Math.min(imgHeight, maxImgHeight);
            const finalWidth = (finalHeight / imgHeight) * imgWidth;
            const xOffset = (pageWidth - finalWidth) / 2;
            doc.addImage(imgData, 'PNG', xOffset, 25, finalWidth, finalHeight);
        } catch (imgError) {
            console.warn('Could not add graph image to PDF:', imgError);
        }
    }

    const fileName = `network_report_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.pdf`;
    doc.save(fileName);
    setStatus('✅ PDF exported successfully!');
}

// ============================================================
// ===== TOOLBAR =====
// ============================================================
document.getElementById('scanBtn').addEventListener('click', startScan);
document.getElementById('subnetInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startScan();
});

document.getElementById('exportJSON').addEventListener('click', exportJSON);
document.getElementById('exportCSV').addEventListener('click', exportCSV);
document.getElementById('exportPNG').addEventListener('click', exportPNG);
document.getElementById('exportPDF').addEventListener('click', exportPDF);
document.getElementById('history-toggle').addEventListener('click', toggleHistoryPanel);

// ===== دکمه‌های لینک دستی و ریست موقعیت =====
const linkBtn = document.createElement('button');
linkBtn.id = 'link-mode-btn';
linkBtn.className = 'export-btn';
linkBtn.textContent = '🔗 Add Link';
linkBtn.title = 'Click on two nodes to create a link';
linkBtn.style.borderColor = '#58a6ff';
linkBtn.style.color = '#58a6ff';
document.querySelector('.export-group').appendChild(linkBtn);

const clearPosBtn = document.createElement('button');
clearPosBtn.id = 'clear-positions-btn';
clearPosBtn.className = 'export-btn';
clearPosBtn.textContent = '🗑️ Reset Positions';
clearPosBtn.title = 'Clear saved node positions';
clearPosBtn.style.borderColor = '#f85149';
clearPosBtn.style.color = '#f85149';
document.querySelector('.export-group').appendChild(clearPosBtn);

document.getElementById('link-mode-btn').addEventListener('click', toggleLinkMode);
document.getElementById('clear-positions-btn').addEventListener('click', clearNodePositions);

// ============================================================
// ===== حالت لینک دستی =====
// ============================================================
function toggleLinkMode() {
    linkSelectionMode = !linkSelectionMode;
    const btn = document.getElementById('link-mode-btn');
    if (linkSelectionMode) {
        btn.textContent = '🔗 Cancel Link';
        btn.style.borderColor = '#f85149';
        btn.style.color = '#f85149';
        setStatus('🔗 Click on two nodes to create a link between them');
        document.body.style.cursor = 'crosshair';
    } else {
        btn.textContent = '🔗 Add Link';
        btn.style.borderColor = '#58a6ff';
        btn.style.color = '#58a6ff';
        setStatus('Link mode deactivated');
        document.body.style.cursor = 'default';
        selectedNodeForLink = null;
    }
}

function handleNodeClickForLink(event, node) {
    if (!linkSelectionMode) return;
    event.stopPropagation();
    
    const nodeId = node.id || node.ip;
    if (!nodeId) return;

    if (selectedNodeForLink === null) {
        selectedNodeForLink = nodeId;
        setStatus(`🔗 Selected ${nodeId}. Click on another node to link.`);
        d3.selectAll('.node')
            .filter(d => (d.id === nodeId || d.ip === nodeId))
            .select('circle')
            .attr('stroke', '#ffcc00')
            .attr('stroke-width', 4);
    } else {
        const sourceId = selectedNodeForLink;
        const targetId = nodeId;
        if (sourceId !== targetId) {
            const success = saveManualLink(sourceId, targetId);
            if (success) {
                setStatus(`✅ Link created between ${sourceId} and ${targetId}`);
                addManualLinkToGraph(sourceId, targetId);
            } else {
                setStatus(`⚠️ Link already exists or invalid`);
            }
        } else {
            setStatus('⚠️ Cannot link a node to itself');
        }
        selectedNodeForLink = null;
        linkSelectionMode = false;
        document.getElementById('link-mode-btn').textContent = '🔗 Add Link';
        document.getElementById('link-mode-btn').style.borderColor = '#58a6ff';
        document.getElementById('link-mode-btn').style.color = '#58a6ff';
        document.body.style.cursor = 'default';
        d3.selectAll('.node').select('circle')
            .attr('stroke', '#161b22')
            .attr('stroke-width', 2);
    }
}

function addManualLinkToGraph(sourceId, targetId) {
    if (!currentData || !currentData.nodes) return;
    const sourceNode = currentData.nodes.find(n => (n.id === sourceId || n.ip === sourceId));
    const targetNode = currentData.nodes.find(n => (n.id === targetId || n.ip === targetId));
    if (!sourceNode || !targetNode) return;

    if (!currentData.links) currentData.links = [];
    const exists = currentData.links.some(l => 
        (l.source === sourceId && l.target === targetId) ||
        (l.source === targetId && l.target === sourceId)
    );
    if (!exists) {
        currentData.links.push({
            source: sourceId,
            target: targetId,
            type: 'manual'
        });
        createGraph(currentData);
    }
}

// ============================================================
// ===== جستجو =====
// ============================================================
const searchInput = document.getElementById('searchInput');
searchInput.addEventListener('input', function() {
    const query = this.value.trim().toLowerCase();
    if (!currentData || !currentData.nodes) return;
    if (!query) { resetHighlight(); return; }
    const matchedNode = currentData.nodes.find(n => {
        const ip = (n.ip || '').toLowerCase();
        const host = (n.hostname || n.name || n.customName || n.category || '').toLowerCase();
        const mac = (n.mac || '').toLowerCase();
        return ip.includes(query) || host.includes(query) || mac.includes(query);
    });
    if (matchedNode) { highlightDevice(matchedNode); } else { resetHighlight(); }
});

function resetHighlight() {
    d3.selectAll('.node').style('opacity', 1).select('circle').attr('stroke', '#161b22').attr('stroke-width', 2);
}

function highlightDevice(node) {
    d3.selectAll('.node').style('opacity', d => d.id === node.id ? 1 : 0.3).select('circle').attr('stroke', d => d.id === node.id ? '#ffcc00' : '#161b22').attr('stroke-width', d => d.id === node.id ? 4 : 2);
    showDeviceDetails(node);
}

function setStatus(msg, isLoading = false) {
    const el = document.getElementById('status-msg');
    if (isLoading) { el.innerHTML = `<span class="spinner"></span> ${msg}`; } else { el.textContent = msg; }
}

// ============================================================
// ===== اسکن =====
// ============================================================
async function startScan() {
    const input = document.getElementById('subnetInput');
    const range = input.value.trim();
    if (!range) { setStatus('Please enter a subnet range.'); return; }
    const btn = document.getElementById('scanBtn');
    const exportBtns = document.querySelectorAll('.export-btn');
    btn.disabled = true;
    exportBtns.forEach(b => b.disabled = true);
    setStatus('Scanning network...', true);
    try {
        const url = `/api/scan?range=${encodeURIComponent(range)}`;
        const resp = await fetch(url);
        if (!resp.ok) { const err = await resp.json(); throw new Error(err.error || 'Scan failed'); }
        const data = await resp.json();
        currentData = data;
        applyCustomNamesToNodes(currentData.nodes);
        createGraph(currentData);
        setStatus(`✅ Scan complete. Found ${data.nodes ? data.nodes.filter(n => n.isAlive).length : 0} devices.`);
        startGlobalUptimeTimer();
        saveToHistory(data);
    } catch (err) {
        setStatus(`❌ Error: ${err.message}`);
        console.error(err);
    } finally {
        btn.disabled = false;
        exportBtns.forEach(b => b.disabled = false);
    }
}

// ========== نرمال‌سازی ==========
function normalizeNodeRef(ref) {
    if (!ref) return null;
    if (typeof ref === 'object') return ref.id || ref.ip || ref.name || null;
    return String(ref);
}

// ========== Uptime ==========
function updateAllUptimes() {
    const panel = document.getElementById('details-panel');
    if (panel && panel.style.display !== 'none') {
        const ip = document.getElementById('d-ip').textContent;
        const node = currentData?.nodes?.find(n => n.ip === ip);
        if (node && node.isAlive && node.firstSeen) {
            const uptimeEl = document.getElementById('d-uptime');
            uptimeEl.textContent = formatUptime(node.firstSeen);
        }
    }
    if (currentData && currentData.nodes) {
        d3.selectAll('.node').each(function(d) {
            if (d.isAlive && d.firstSeen) {
                const textEl = d3.select(this).select('.label-uptime');
                if (!textEl.empty()) {
                    textEl.text('⏱ ' + formatUptime(d.firstSeen));
                }
            } else if (!d.isAlive) {
                const textEl = d3.select(this).select('.label-uptime');
                if (!textEl.empty()) {
                    textEl.text('⏹ Offline');
                }
            }
        });
    }
}

function startGlobalUptimeTimer() {
    if (globalUptimeInterval) { clearInterval(globalUptimeInterval); }
    updateAllUptimes();
    globalUptimeInterval = setInterval(updateAllUptimes, 1000);
}

// ============================================================
// ===== createGraph =====
// ============================================================
function createGraph(data) {
    const width = window.innerWidth;
    const height = window.innerHeight;

    console.log('🔍 DEBUG: Total nodes:', data.nodes ? data.nodes.length : 0);
    console.log('🔍 DEBUG: Total links from server:', data.links ? data.links.length : 0);

    const nodeCount = (data.nodes || []).length;
    const baseRadius = Math.max(250, Math.min(700, nodeCount * 2.8));
    const angleStep = (Math.PI * 2) / Math.max(1, nodeCount);

    const nodes = (data.nodes || []).map((node, index) => ({
        ...node,
        id: node.id || node.ip || `node-${index}`,
        x: node.x ?? (Math.cos(index * angleStep) * baseRadius),
        y: node.y ?? (Math.sin(index * angleStep) * baseRadius),
        firstSeen: node.firstSeen || Date.now(),
        customName: node.customName || null
    }));

    loadNodePositions(nodes);

    const nodeIds = new Set(nodes.map(n => n.id));
    let validLinks = (data.links || [])
        .map(link => ({
            ...link,
            source: normalizeNodeRef(link.source),
            target: normalizeNodeRef(link.target)
        }))
        .filter(link => {
            const source = normalizeNodeRef(link.source);
            const target = normalizeNodeRef(link.target);
            return source && target && nodeIds.has(source) && nodeIds.has(target);
        });

    validLinks = loadManualLinks(nodes, validLinks);

    if (validLinks.length === 0 && nodes.length > 1) {
        const gateway = nodes.find(n => n.isGateway === true);
        const center = gateway ? gateway.id : nodes[0].id;
        const centerSubnet = nodes.find(n => n.id === center)?.subnet;
        validLinks = nodes
            .filter(n => n.id !== center)
            .map(n => {
                let type = 'default';
                if (n.isGateway) type = 'route';
                else if (centerSubnet && n.subnet === centerSubnet) type = 'subnet';
                else if (n.ports && n.ports.length > 0 && !gateway) type = 'subnet';
                return { source: center, target: n.id, type: type };
            });
    }

    d3.select("#graph").selectAll("*").remove();
    svg = d3.select("#graph").append("svg").attr("width", width).attr("height", height);

    const defs = svg.append("defs");
    defs.append("filter").attr("id", "text-shadow").append("feDropShadow").attr("dx", 0).attr("dy", 0).attr("stdDeviation", 3).attr("flood-color", "#0d1117").attr("flood-opacity", 0.9);

    graphGroup = svg.append("g").attr("class", "graph-container");

    // ===== Links =====
    const link = graphGroup.selectAll(".link")
        .data(validLinks)
        .join("line")
        .attr("class", "link")
        .attr("stroke", d => {
            if (d.type === 'subnet') return '#3fb950';
            if (d.type === 'route') return '#d29922';
            if (d.type === 'manual') return '#a371f7';
            return '#58a6ff';
        })
        .attr("stroke-width", d => {
            if (d.type === 'manual') return 3;
            if (d.type === 'subnet') return 3;
            if (d.type === 'route') return 2;
            return 2.5;
        })
        .attr("stroke-linecap", "round")
        .attr("opacity", d => {
            if (d.type === 'manual') return 0.9;
            if (d.type === 'subnet') return 0.95;
            return 0.85;
        })
        .attr("stroke-dasharray", d => (d.type === 'route' ? '6,4' : null))
        .style("transition", "stroke-width 0.2s, opacity 0.2s")
        .on("mouseover", function(event, d) {
            d3.select(this).attr("stroke-width", 5).attr("opacity", 1);
            const sourceId = normalizeNodeRef(d.source);
            const targetId = normalizeNodeRef(d.target);
            const sourceNode = nodes.find(n => n.id === sourceId);
            const targetNode = nodes.find(n => n.id === targetId);
            const typeLabels = {
                'subnet': '🌐 Subnet Connection',
                'route': '🛤️ Route Connection',
                'default': '🔗 Default Connection',
                'manual': '✏️ Manual Link'
            };
            const typeLabel = typeLabels[d.type] || '🔗 Connection';
            const sourceIP = sourceNode?.ip || sourceNode?.id || 'Unknown';
            const targetIP = targetNode?.ip || targetNode?.id || 'Unknown';
            let extraInfo = d.type === 'subnet' ? `Same subnet (${sourceNode?.subnet || 'N/A'})` : 
                           (d.type === 'route' ? 'Gateway routing path' : 
                           (d.type === 'manual' ? 'User-created link' : 'Default connection'));
            const tooltipContent = `
                <div style="font-weight: bold; margin-bottom: 4px; color: #f0f6fc;">${typeLabel}</div>
                <div style="display: flex; flex-direction: column; gap: 2px; font-size: 11px;">
                    <div><span style="color: #8b949e;">From:</span> <span style="color: #58a6ff; font-family: monospace;">${sourceIP}</span></div>
                    <div><span style="color: #8b949e;">To:</span> <span style="color: #58a6ff; font-family: monospace;">${targetIP}</span></div>
                    <div style="border-top: 1px solid #21262d; margin-top: 3px; padding-top: 3px; color: #8b949e;">${extraInfo}</div>
                    ${d.type === 'manual' ? `<div style="color: #a371f7; font-size: 10px;">Right-click to delete this link</div>` : ''}
                </div>
            `;
            const tooltip = document.getElementById('link-tooltip');
            document.getElementById('link-tooltip-content').innerHTML = tooltipContent;
            tooltip.style.display = 'block';
        })
        .on("mousemove", function(event) {
            const tooltip = document.getElementById('link-tooltip');
            const offsetX = 15, offsetY = 15;
            let left = event.clientX + offsetX, top = event.clientY + offsetY;
            const tw = tooltip.offsetWidth || 250, th = tooltip.offsetHeight || 100;
            if (left + tw > window.innerWidth) left = event.clientX - tw - offsetX;
            if (top + th > window.innerHeight) top = event.clientY - th - offsetX;
            tooltip.style.left = left + 'px';
            tooltip.style.top = top + 'px';
        })
        .on("mouseout", function() {
            const d = d3.select(this).datum();
            const sw = d.type === 'manual' ? 3 : (d.type === 'subnet' ? 3 : (d.type === 'route' ? 2 : 2.5));
            const op = d.type === 'manual' ? 0.9 : (d.type === 'subnet' ? 0.95 : 0.85);
            d3.select(this).attr("stroke-width", sw).attr("opacity", op);
            document.getElementById('link-tooltip').style.display = 'none';
        })
        .on("contextmenu", function(event, d) {
            if (d.type === 'manual') {
                event.preventDefault();
                if (confirm(`Delete manual link between ${d.source} and ${d.target}?`)) {
                    const sourceId = normalizeNodeRef(d.source);
                    const targetId = normalizeNodeRef(d.target);
                    deleteManualLink(sourceId, targetId);
                    if (currentData && currentData.links) {
                        currentData.links = currentData.links.filter(l => 
                            !(l.source === sourceId && l.target === targetId) &&
                            !(l.source === targetId && l.target === sourceId)
                        );
                    }
                    createGraph(currentData);
                    setStatus('🗑️ Manual link deleted');
                }
            }
        });

    // ===== Nodes =====
    const node = graphGroup.selectAll(".node")
        .data(nodes)
        .join("g")
        .attr("class", "node")
        .style("cursor", "pointer")
        .on("click", function(event, d) {
            if (linkSelectionMode) {
                handleNodeClickForLink(event, d);
                return;
            }
            showDeviceDetails(d);
            document.getElementById('searchInput').value = '';
            resetHighlight();
        });

    node.append("circle")
        .attr("r", d => { const base = 14; const portBonus = (d.ports && d.ports.length > 0) ? Math.min(d.ports.length * 1.5, 12) : 0; return base + portBonus; })
        .attr("fill", d => {
            const isAlive = d.isAlive !== undefined ? d.isAlive : true;
            if (!isAlive) return '#8b949e';
            if (d.isGateway) return '#d29922';
            if (d.ports && d.ports.length > 0) return '#58a6ff';
            if (d.subnet) {
                const colors = { '192.168.67.0/24': '#3fb950', '192.168.1.0/24': '#3fb950', '10.0.0.0/24': '#f0883e', '172.16.0.0/24': '#f0883e' };
                return colors[d.subnet] || '#8b949e';
            }
            return '#8b949e';
        })
        .attr("stroke", "#161b22").attr("stroke-width", 2)
        .attr("opacity", d => (d.isAlive !== undefined && !d.isAlive) ? 0.4 : 1)
        .style("transition", "fill 0.3s ease, opacity 0.3s ease")
        .call(d3.drag()
            .on("start", function(event, d) {
                if (!event.active) simulation.alphaTarget(0.3).restart();
                d.fx = d.x;
                d.fy = d.y;
            })
            .on("drag", function(event, d) {
                d.fx = event.x;
                d.fy = event.y;
                saveNodePositions(nodes);
            })
            .on("end", function(event, d) {
                if (!event.active) simulation.alphaTarget(0);
                d.fx = null;
                d.fy = null;
                saveNodePositions(nodes);
            })
        );

    node.append("text")
        .attr("class", "label-ip")
        .text(d => d.ip || d.id || '')
        .attr("dx", 18).attr("dy", -8)
        .attr("fill", "#f0f6fc").attr("font-size", "11px").attr("font-family", "monospace").attr("font-weight", "bold")
        .attr("opacity", 0.9).style("filter", "url(#text-shadow)").style("pointer-events", "none");

    node.append("text")
        .attr("class", "label-name")
        .text(d => {
            let name = d.customName || d.hostname || d.name || d.category || 'Device';
            if (name === d.ip || name === '') name = d.category || 'Device';
            if (name.includes('Unknown') || name.includes('❓')) name = 'Device';
            return name.length > 22 ? name.substring(0, 20) + '…' : name;
        })
        .attr("dx", 18).attr("dy", 6)
        .attr("fill", "#8b949e").attr("font-size", "10px").attr("font-family", "sans-serif")
        .attr("opacity", 0.8).style("filter", "url(#text-shadow)").style("pointer-events", "none");

    node.append("text")
        .attr("class", "label-uptime")
        .text(d => {
            if (!d.isAlive) return '⏹ Offline';
            if (!d.firstSeen) return '⏳ N/A';
            return '⏱ ' + formatUptime(d.firstSeen);
        })
        .attr("dx", 18).attr("dy", 18)
        .attr("fill", "#58a6ff").attr("font-size", "9px").attr("font-family", "monospace")
        .attr("opacity", 0.7).style("filter", "url(#text-shadow)").style("pointer-events", "none");

    drawSubnetClusters(nodes, graphGroup);

    simulation = d3.forceSimulation(nodes)
        .force("link", d3.forceLink(validLinks).id(d => d.id).distance(200))
        .force("charge", d3.forceManyBody().strength(-1200))
        .force("center", d3.forceCenter(0, 0))
        .force("x", d3.forceX(0).strength(0.05))
        .force("y", d3.forceY(0).strength(0.05));

    simulation.on("tick", () => {
        link.attr("x1", d => d.source?.x ?? 0)
            .attr("y1", d => d.source?.y ?? 0)
            .attr("x2", d => d.target?.x ?? 0)
            .attr("y2", d => d.target?.y ?? 0);
        node.attr("transform", d => `translate(${d.x},${d.y})`);
        updateClusterPositions();
    });

    for (let i = 0; i < 120; ++i) simulation.tick();

    zoom = d3.zoom().scaleExtent([0.1, 5]).on("zoom", (event) => { graphGroup.attr("transform", event.transform); });
    svg.call(zoom);

    const bounds = graphGroup.node().getBBox();
    if (bounds.width > 0 && bounds.height > 0) {
        const padding = 120;
        const scale = 0.9 * Math.min(width / (bounds.width + padding), height / (bounds.height + padding));
        const tx = width/2 - (bounds.x + bounds.width/2) * scale;
        const ty = height/2 - (bounds.y + bounds.height/2) * scale;
        svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(Math.min(scale, 1.5)));
    }

    simulation.restart();
    console.log('✅ Graph rendering complete. Nodes:', nodes.length, 'Links:', validLinks.length);
}

// ============================================================
// ===== وضعیت گره‌ها =====
// ============================================================
function updateNodeStatuses(devices) {
    devices.forEach(device => {
        const node = currentData?.nodes?.find(n => n.ip === device.ip);
        if (node) {
            const wasAlive = node.isAlive;
            node.isAlive = device.isAlive;
            node.latency = device.latency;
            if (device.isAlive && !wasAlive) node.firstSeen = Date.now();
            d3.selectAll('.node')
                .filter(d => d.ip === device.ip)
                .select('circle')
                .attr('fill', d => getNodeColor(d, device.isAlive))
                .attr('opacity', device.isAlive ? 1 : 0.4);
            const panel = document.getElementById('details-panel');
            if (panel.style.display !== 'none') {
                const currentIp = document.getElementById('d-ip').textContent;
                if (currentIp === device.ip) showDeviceDetails(node);
            }
        }
    });
}

function getNodeColor(d, isAlive) {
    if (!isAlive) return '#8b949e';
    if (d.isGateway) return '#d29922';
    if (d.ports && d.ports.length > 0) return '#58a6ff';
    if (d.subnet) {
        const colors = { '192.168.67.0/24': '#3fb950', '192.168.1.0/24': '#3fb950', '10.0.0.0/24': '#f0883e', '172.16.0.0/24': '#f0883e' };
        return colors[d.subnet] || '#8b949e';
    }
    return '#8b949e';
}

// ============================================================
// ===== جزئیات دستگاه (با تحلیل امنیتی) =====
// ============================================================
function showDeviceDetails(node) {
    if (!node) return;
    const panel = document.getElementById('details-panel');
    panel.style.display = 'block';

    document.getElementById('d-ip').textContent = node.ip || node.id || '-';
    document.getElementById('d-mac').textContent = node.mac || 'Unknown';

    const hostnameEl = document.getElementById('d-hostname');
    const displayName = node.customName || node.hostname || node.name || 'N/A';
    hostnameEl.textContent = displayName;
    hostnameEl.contentEditable = true;
    hostnameEl.style.cursor = 'text';
    hostnameEl.style.borderBottom = '1px dashed #58a6ff';
    hostnameEl.style.padding = '0 4px';
    hostnameEl.style.borderRadius = '4px';
    hostnameEl.title = 'Click to edit name';

    hostnameEl.onblur = null;
    hostnameEl.onkeydown = null;

    hostnameEl.onblur = function() {
        const newName = this.textContent.trim();
        if (newName !== node.ip && newName !== '') {
            saveCustomName(node.ip || node.id, newName);
            node.customName = newName;
            updateNodeLabel(node);
            this.textContent = newName;
            this.style.borderBottom = '1px dashed #58a6ff';
            setStatus(`✏️ Device renamed to "${newName}"`);
        } else {
            const fallbackName = node.hostname || node.name || node.ip || 'N/A';
            this.textContent = fallbackName;
            saveCustomName(node.ip || node.id, '');
            node.customName = null;
            updateNodeLabel(node);
            setStatus('❌ Invalid name, reverted to default');
        }
    };

    hostnameEl.onkeydown = function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            this.blur();
        }
        if (e.key === 'Escape') {
            const fallbackName = node.customName || node.hostname || node.name || node.ip || 'N/A';
            this.textContent = fallbackName;
            this.blur();
        }
    };

    document.getElementById('d-category').textContent = node.category || 'Unknown';
    document.getElementById('d-vendor').textContent = node.manufacturer?.companyName || 'Unknown';

    const statusEl = document.getElementById('d-status');
    statusEl.innerHTML = node.isAlive ? '<span class="online">🟢 Online</span>' : '<span class="offline">🔴 Offline</span>';

    const latencyEl = document.getElementById('d-latency');
    latencyEl.textContent = (node.latency !== undefined && node.latency !== null) ? `${node.latency} ms` : 'N/A';

    const uptimeEl = document.getElementById('d-uptime');
    if (node.isAlive && node.firstSeen) uptimeEl.textContent = formatUptime(node.firstSeen);
    else if (node.isAlive === false) uptimeEl.textContent = 'Offline';
    else uptimeEl.textContent = 'N/A';

    const gwEl = document.getElementById('d-gateway');
    gwEl.innerHTML = node.isGateway ? '<span class="gateway-yes">✅ Yes</span>' : '❌ No';

    const portsContainer = document.getElementById('d-ports');
    portsContainer.innerHTML = '';
    if (node.ports && node.ports.length > 0) {
        node.ports.forEach(p => {
            const badge = document.createElement('span');
            badge.className = 'port-badge';
            badge.textContent = p;
            portsContainer.appendChild(badge);
        });
    } else {
        portsContainer.innerHTML = '<span style="color:#8b949e; font-style:italic;">No open ports detected</span>';
    }

    // ===== دکمه تحلیل امنیتی =====
    const securityBtn = document.getElementById('security-check-btn');
    const securityResults = document.getElementById('security-results');
    const securityContent = document.getElementById('security-results-content');

    securityBtn.onclick = null;
    securityBtn.onclick = async function() {
        const ip = document.getElementById('d-ip').textContent;
        if (!ip || ip === '-') {
            securityContent.innerHTML = '<span style="color: #f85149;">❌ No IP address found</span>';
            securityResults.style.display = 'block';
            return;
        }

        securityContent.innerHTML = '<span style="color: #58a6ff;">⏳ Checking security for ' + ip + '...</span>';
        securityResults.style.display = 'block';
        securityBtn.disabled = true;
        securityBtn.style.opacity = '0.6';

        try {
            const response = await fetch(`/api/security-check?ip=${encodeURIComponent(ip)}`);
            const data = await response.json();

            if (data.error) {
                securityContent.innerHTML = `<span style="color: #f85149;">❌ ${data.error}</span>`;
                return;
            }

            let html = '';
            
            if (data.ports && data.ports.length > 0) {
                html += `<div style="margin-bottom: 6px;"><strong style="color: #58a6ff;">🔌 Open Ports:</strong> ${data.ports.join(', ')}</div>`;
            }

            if (data.vulns && data.vulns.length > 0) {
                html += `<div style="margin-top: 6px; border-top: 1px solid #21262d; padding-top: 6px;">`;
                html += `<strong style="color: #f85149;">⚠️ Vulnerabilities (${data.vulns.length}):</strong>`;
                
                if (data.cveDetails && data.cveDetails.length > 0) {
                    data.cveDetails.forEach(cve => {
                        const severityColor = cve.severity === 'CRITICAL' ? '#f85149' : 
                                            cve.severity === 'HIGH' ? '#d29922' : 
                                            cve.severity === 'MEDIUM' ? '#f0883e' : '#58a6ff';
                        html += `
                            <div style="margin: 4px 0; padding: 4px 8px; background: #161b22; border-radius: 4px; border-left: 3px solid ${severityColor};">
                                <div style="display: flex; justify-content: space-between; align-items: center;">
                                    <span style="font-weight: bold; color: #f0f6fc;">${cve.id}</span>
                                    <span style="color: ${severityColor}; font-size: 11px;">CVSS: ${cve.cvss} (${cve.severity})</span>
                                </div>
                                <div style="font-size: 11px; color: #8b949e; margin-top: 2px;">${cve.description || 'No description'}</div>
                                <div style="font-size: 10px; color: #484f58; margin-top: 2px;">
                                    Published: ${cve.published}
                                    ${cve.references && cve.references !== 'N/A' ? ` | <a href="${cve.references}" target="_blank" style="color: #58a6ff;">Reference</a>` : ''}
                                </div>
                            </div>
                        `;
                    });
                } else {
                    html += `<div style="margin: 4px 0; color: #8b949e; font-size: 12px;">${data.vulns.join(', ')}</div>`;
                    html += `<div style="color: #484f58; font-size: 11px; margin-top: 4px;">💡 Click on a CVE ID to search online</div>`;
                }
                html += `</div>`;
            } else {
                html += `<div style="margin-top: 6px; border-top: 1px solid #21262d; padding-top: 6px;">`;
                html += `<span style="color: #3fb950;">✅ No known public vulnerabilities found</span>`;
                html += `</div>`;
            }

            if (data.hostnames && data.hostnames.length > 0) {
                html += `<div style="margin-top: 4px; font-size: 11px; color: #484f58;">🌐 Hostnames: ${data.hostnames.join(', ')}</div>`;
            }
            if (data.tags && data.tags.length > 0) {
                html += `<div style="margin-top: 2px; font-size: 11px; color: #484f58;">🏷️ Tags: ${data.tags.join(', ')}</div>`;
            }

            if (!data.ports && !data.vulns && !data.hostnames) {
                html = `<span style="color: #8b949e;">ℹ️ No public information found for this IP</span>`;
            }

            securityContent.innerHTML = html;

        } catch (error) {
            console.error('Security check error:', error);
            securityContent.innerHTML = `<span style="color: #f85149;">❌ Failed to check security: ${error.message}</span>`;
        } finally {
            securityBtn.disabled = false;
            securityBtn.style.opacity = '1';
        }
    };
}

function updateNodeLabel(node) {
    if (!node) return;
    const ip = node.ip || node.id;
    d3.selectAll('.node')
        .filter(d => (d.ip === ip || d.id === ip))
        .select('.label-name')
        .text(d => {
            let name = d.customName || d.hostname || d.name || d.category || 'Device';
            if (name === d.ip || name === '') name = d.category || 'Device';
            if (name.includes('Unknown') || name.includes('❓')) name = 'Device';
            return name.length > 22 ? name.substring(0, 20) + '…' : name;
        });
}

function closeDetails() {
    document.getElementById('details-panel').style.display = 'none';
}

// ============================================================
// ===== بارگذاری خودکار آخرین اسکن =====
// ============================================================
function loadLastScanFromHistory() {
    const history = getHistory();
    if (history.length > 0) {
        const latest = history[0];
        loadFromHistory(latest);
        setStatus(`📂 Auto-loaded last scan: ${latest.range} (${latest.nodeCount} devices)`);
    } else {
        setStatus('No previous scan found. Please scan a network.');
    }
}

window.addEventListener('load', () => {
    startConsolePolling();
    setTimeout(startPolling, 3000);
    setTimeout(loadLastScanFromHistory, 500);
    renderHistoryList();
});

window.addEventListener('beforeunload', () => {
    if (pollingInterval) clearInterval(pollingInterval);
    if (consolePollingInterval) clearInterval(consolePollingInterval);
});

setStatus('Enter a subnet and click Scan');