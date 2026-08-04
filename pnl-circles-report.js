// ══════════════════════════════════════════════════════════════════
// PNL RATE — circular gauges + Win by Strategy + Profit per Day
// Same visual language as the reference screenshots: donut-ring gauges
// for Win Rate / Total Profit / Loss Rate, a vertical bar chart for
// best-performing setups, and a day-by-day profit chart.
// ══════════════════════════════════════════════════════════════════
function fmtMoney(curr, v) {
    v = Number(v) || 0;
    const sign = v >= 0 ? '+' : '-';
    return `${sign}${curr}${Math.abs(v).toFixed(2)}`;
}

function drawRing(canvas, pct, color) {
    if (!canvas) return;
    const isLight = document.body.classList.contains('light-mode');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const size = rect.width, cx = size / 2, cy = size / 2, r = size / 2 - 9;
    ctx.clearRect(0, 0, size, size);

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 9;
    ctx.stroke();

    const clamped = Math.max(0, Math.min(100, pct));
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (clamped / 100) * Math.PI * 2);
    ctx.strokeStyle = (isLight && color === '#ffffff') ? '#1a1a1a' : color;
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.stroke();
}

function drawBarChart(canvas, items) {
    if (!canvas || !items.length) return;
    const isLight = document.body.classList.contains('light-mode');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;
    ctx.clearRect(0, 0, W, H);

    const padL = 40, padR = 10, padT = 14, padB = 26;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const maxV = Math.max(...items.map(i => Math.abs(i.value)), 1);
    const barW = plotW / items.length * 0.5;
    const gap = plotW / items.length;

    items.forEach((it, i) => {
        const x = padL + gap * i + (gap - barW) / 2;
        const h = (Math.abs(it.value) / maxV) * plotH;
        const y = padT + plotH - h;
        ctx.fillStyle = it.color;
        ctx.fillRect(x, y, barW, h);
        ctx.fillStyle = isLight ? '#1a1a1a' : '#fff'; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center';
        ctx.fillText(`$${Math.abs(it.value).toFixed(0)}`, x + barW / 2, y - 5);
        ctx.fillStyle = isLight ? '#666' : '#888'; ctx.font = '9px monospace';
        ctx.fillText(it.label, x + barW / 2, H - 8);
    });
}

function drawDailyChart(canvas, days) {
    if (!canvas || !days.length) return;
    const isLight = document.body.classList.contains('light-mode');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;
    ctx.clearRect(0, 0, W, H);

    const padL = 44, padR = 10, padT = 14, padB = 24;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const values = days.map(d => d.pl);
    const min = Math.min(0, ...values), max = Math.max(0, ...values);
    const pad = (max - min) * 0.15 || 10;
    const yMin = min - pad, yMax = max + pad;

    const xFor = i => padL + (days.length <= 1 ? plotW / 2 : (i / (days.length - 1)) * plotW);
    const yFor = v => padT + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

    ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, yFor(0)); ctx.lineTo(W - padR, yFor(0)); ctx.stroke();

    days.forEach((d, i) => {
        const x = xFor(i), barW = Math.min(24, plotW / days.length * 0.5);
        const y0 = yFor(0), y1 = yFor(d.pl);
        ctx.fillStyle = d.pl >= 0 ? '#00e6a0' : '#ff5566';
        ctx.fillRect(x - barW / 2, Math.min(y0, y1), barW, Math.abs(y1 - y0) || 1);
    });

    ctx.fillStyle = isLight ? '#555' : '#666'; ctx.font = '9px monospace'; ctx.textAlign = 'center';
    days.forEach((d, i) => {
        if (days.length > 10 && i % Math.ceil(days.length / 8) !== 0) return;
        ctx.fillText(d.date.slice(5), xFor(i), H - 6);
    });
}

export function renderPnlCirclesUI(container, trades) {
    trades = (trades || []).filter(Boolean);
    if (!trades.length) {
        container.innerHTML = `<div style="text-align:center;padding:40px;color:#555;">Is selection ke liye abhi koi trade nahi mila.</div>`;
        return;
    }
    const curr = trades[0]._curr || '$';
    const wins = trades.filter(t => (Number(t.pl) || 0) > 0).length;
    const losses = trades.filter(t => (Number(t.pl) || 0) < 0).length;
    const winRate = (wins / trades.length) * 100;
    const lossRate = (losses / trades.length) * 100;
    const totalProfit = trades.reduce((s, t) => s + (Number(t.pl) || 0), 0);

    // Group by HTF+LTF structure combo (our real "strategy" signature)
    const comboMap = {};
    trades.forEach(t => {
        const key = `${t.htfMs || '—'} · ${t.ltfMs || '—'}`;
        if (!comboMap[key]) comboMap[key] = { label: key, value: 0, count: 0 };
        comboMap[key].value += Number(t.pl) || 0;
        comboMap[key].count++;
    });
    const comboColors = ['#4ad9ff', '#ffd84a', '#ffffff', '#ff9955', '#8a8aff'];
    const combos = Object.values(comboMap).sort((a, b) => b.value - a.value).slice(0, 5)
        .map((c, i) => ({ ...c, color: comboColors[i % comboColors.length] }));

    // Group by date for the daily chart
    const dayMap = {};
    trades.forEach(t => {
        const d = t.date || '—';
        dayMap[d] = (dayMap[d] || 0) + (Number(t.pl) || 0);
    });
    const days = Object.entries(dayMap).sort((a, b) => b[0].localeCompare(a[0])).map(([date, pl]) => ({ date, pl }));

    container.innerHTML = `
        <div class="pc-rings">
            <div class="pc-ring-box">
                <div class="pc-ring-wrap"><canvas id="pcRingWin"></canvas><div class="pc-ring-center"><div class="pc-ring-val">${winRate.toFixed(0)}%</div><div class="pc-ring-lbl">PnL</div></div></div>
                <div class="pc-ring-title">Win Rate</div>
            </div>
            <div class="pc-ring-box">
                <div class="pc-ring-wrap"><canvas id="pcRingProfit"></canvas><div class="pc-ring-center"><div class="pc-ring-val" style="font-size:0.9rem;">${curr}${Math.abs(totalProfit).toFixed(0)}</div></div></div>
                <div class="pc-ring-title">Total Profit</div>
            </div>
            <div class="pc-ring-box">
                <div class="pc-ring-wrap"><canvas id="pcRingLoss"></canvas><div class="pc-ring-center"><div class="pc-ring-val">${lossRate.toFixed(0)}%</div><div class="pc-ring-lbl">Loss Rate</div></div></div>
                <div class="pc-ring-title">Loss Rate</div>
            </div>
        </div>

        <div class="pc-panel">
            <div class="pc-panel-title">Win by Strategy (HTF · LTF combo)</div>
            <canvas id="pcBarChart" style="width:100%;height:160px;"></canvas>
        </div>

        <div class="pc-panel">
            <div class="pc-panel-title">Profit per Day</div>
            <canvas id="pcDailyChart" style="width:100%;height:180px;"></canvas>
        </div>

        <div style="font-size:0.6rem;color:#555;margin-top:10px;">${trades.length} trades · ${wins}W / ${losses}L</div>
    `;

    requestAnimationFrame(() => {
        drawRing(document.getElementById('pcRingWin'), winRate, '#ffffff');
        drawRing(document.getElementById('pcRingProfit'), Math.min(100, Math.abs(totalProfit) / 5), '#4a9eff');
        drawRing(document.getElementById('pcRingLoss'), lossRate, '#ff5566');
        drawBarChart(document.getElementById('pcBarChart'), combos);
        drawDailyChart(document.getElementById('pcDailyChart'), days);
    });
}
