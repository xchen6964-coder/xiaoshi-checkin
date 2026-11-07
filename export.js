/* 小事打卡 · 报告导出生成器
   纯函数：传入数据，返回 Blob 或字符串。浏览器里用 window.CheckinExport，
   Node 里可用 globalThis.CheckinExport 做产物校验。
   依赖全局的 docx 与 XLSX（仅导出 Word/Excel 时才需要）。 */

(function (root) {
  'use strict';

  const STATUS_TEXT = { on_time: '按时', late: '补记', excused: '豁免', missing: '未完成' };

  function pad(n) { return String(n).padStart(2, '0'); }

  function rangeLabel(meta) {
    return `${meta.rangeStart} 至 ${meta.rangeEnd}`;
  }

  function pct(v) {
    if (!isFinite(v) || v == null) return '—';
    return (v * 100).toFixed(1) + '%';
  }

  /* ---------------- CSV ---------------- */
  function buildCsv(data) {
    const head = ['日期', '成员', '任务', '状态', '完成时间', '文字', '点赞', '照片数'];
    const lines = [head.join(',')];
    data.rows.forEach((r) => {
      const cells = [
        r.date,
        r.nickname,
        r.task,
        STATUS_TEXT[r.status] || r.status,
        r.time || '',
        (r.note || '').replace(/"/g, '""'),
        String(r.likes || 0),
        String(r.photos || 0)
      ].map((c) => `"${c}"`);
      lines.push(cells.join(','));
    });
    // BOM 让 Excel 双击打开不乱码
    return '\uFEFF' + lines.join('\r\n');
  }

  /* ---------------- HTML ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  function buildHtml(data) {
    const m = data.metrics;
    const meta = data.meta;
    const memberRows = m.perMember.map((x) => `
      <tr><td>${esc(x.name)}</td><td class="n">${x.expected}</td><td class="n">${x.done}</td>
      <td class="n">${x.late}</td><td class="n">${x.missing}</td><td class="n">${pct(x.rate)}</td></tr>`).join('');
    const taskRows = m.perTask.map((x) => `
      <tr><td>${esc(x.title)}</td><td class="n">${esc(x.deadline)}</td><td class="n">${x.expected}</td>
      <td class="n">${x.done}</td><td class="n">${pct(x.rate)}</td></tr>`).join('');
    const detailRows = data.rows.map((r) => `
      <tr><td class="n">${esc(r.date)}</td><td>${esc(r.nickname)}</td><td>${esc(r.task)}</td>
      <td>${STATUS_TEXT[r.status] || esc(r.status)}</td><td class="n">${esc(r.time || '')}</td>
      <td>${esc(r.note || '')}</td><td class="n">${r.likes || 0}</td><td class="n">${r.photos || 0}</td></tr>`).join('');
    const photoBlocks = (data.photos || []).slice(0, 12).map((p) => `
      <figure><img src="${p.dataUrl}" alt=""><figcaption>${esc(p.caption || '')}</figcaption></figure>`).join('');

    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(meta.groupName)} · 打卡总结 ${esc(rangeLabel(meta))}</title>
<style>
  :root{color-scheme:light}
  body{margin:0;padding:40px 20px;background:#F1F4F9;color:#0F172A;
       font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;line-height:1.6}
  .wrap{max-width:860px;margin:0 auto;background:#fff;border:1px solid #E3E9F2;border-radius:18px;padding:36px 32px}
  h1{margin:0 0 6px;font-size:24px;letter-spacing:-.3px}
  .sub{color:#64748B;font-size:13px;margin-bottom:28px}
  h2{font-size:15px;margin:32px 0 12px;padding-bottom:8px;border-bottom:1px solid #EEF2F7}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0 8px}
  .kpi{background:#F7FAFF;border:1px solid #E3EEF8;border-radius:12px;padding:14px}
  .kpi b{display:block;font-size:22px;font-variant-numeric:tabular-nums}
  .kpi span{font-size:11.5px;color:#64748B}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{padding:8px 6px;border-bottom:1px solid #F1F5F9;text-align:left}
  th{color:#64748B;font-weight:500;font-size:12px;background:#FAFBFD}
  td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
  .summary{background:#F7FBFA;border-left:3px solid #12B5A5;padding:14px 16px;border-radius:0 10px 10px 0;
           font-size:13.5px;white-space:pre-wrap;margin:12px 0 0}
  .photos{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
  figure{margin:0}
  figure img{width:100%;height:96px;object-fit:cover;border-radius:8px;display:block}
  figcaption{font-size:10.5px;color:#94A3B8;margin-top:4px}
  .foot{margin-top:28px;font-size:11.5px;color:#94A3B8}
  @media (max-width:640px){.kpis{grid-template-columns:repeat(2,1fr)}.photos{grid-template-columns:repeat(2,1fr)}.wrap{padding:24px 18px}}
  @media print{body{padding:0;background:#fff}.wrap{border:none;border-radius:0}}
</style></head>
<body><div class="wrap">
  <h1>${esc(meta.groupName)} · 打卡总结</h1>
  <div class="sub">${esc(rangeLabel(meta))}　共 ${meta.days} 天　${meta.members} 人　${meta.tasks} 项任务　生成于 ${esc(meta.generatedAt)}</div>

  <div class="kpis">
    <div class="kpi"><b>${pct(m.rateOnTime)}</b><span>按时率</span></div>
    <div class="kpi"><b>${pct(m.rateDone)}</b><span>完成率（含补记）</span></div>
    <div class="kpi"><b>${m.onTime}</b><span>按时打卡条数</span></div>
    <div class="kpi"><b>${m.missing}</b><span>未完成条数</span></div>
  </div>

  ${data.summary ? `<h2>总结</h2><div class="summary">${esc(data.summary)}</div>` : ''}

  <h2>成员</h2>
  <table><thead><tr><th>成员</th><th class="n">应完成</th><th class="n">按时</th><th class="n">补记</th><th class="n">未完成</th><th class="n">按时率</th></tr></thead>
  <tbody>${memberRows}</tbody></table>

  <h2>任务</h2>
  <table><thead><tr><th>任务</th><th class="n">截止</th><th class="n">应完成</th><th class="n">完成</th><th class="n">完成率</th></tr></thead>
  <tbody>${taskRows}</tbody></table>

  ${photoBlocks ? `<h2>照片</h2><div class="photos">${photoBlocks}</div>` : ''}

  <h2>明细</h2>
  <table><thead><tr><th class="n">日期</th><th>成员</th><th>任务</th><th>状态</th><th class="n">时间</th><th>文字</th><th class="n">点赞</th><th class="n">照片</th></tr></thead>
  <tbody>${detailRows}</tbody></table>

  <div class="foot">由「小事打卡」生成 · ${esc(meta.generatedAt)}</div>
</div></body></html>`;
  }

  /* ---------------- XLSX ---------------- */
  function buildXlsx(data, lib) {
    const XLSX = lib || root.XLSX;
    if (!XLSX) throw new Error('XLSX 未加载');
    const wb = XLSX.utils.book_new();
    const m = data.metrics;

    const summary = [
      ['小事打卡 · 汇总'],
      ['小组', data.meta.groupName],
      ['区间', `${data.meta.rangeStart} ~ ${data.meta.rangeEnd}`],
      ['天数', data.meta.days],
      ['成员数', data.meta.members],
      ['任务数', data.meta.tasks],
      [],
      ['按时率', pct(m.rateOnTime)],
      ['完成率（含补记）', pct(m.rateDone)],
      ['应完成', m.expected],
      ['按时', m.onTime],
      ['补记', m.late],
      ['豁免', m.excused],
      ['未完成', m.missing],
      [],
      ['成员', '应完成', '按时', '补记', '未完成', '按时率']
    ];
    m.perMember.forEach((x) => summary.push([x.name, x.expected, x.done, x.late, x.missing, pct(x.rate)]));
    summary.push([]);
    summary.push(['任务', '截止', '应完成', '完成', '完成率']);
    m.perTask.forEach((x) => summary.push([x.title, x.deadline, x.expected, x.done, pct(x.rate)]));

    const ws1 = XLSX.utils.aoa_to_sheet(summary);
    ws1['!cols'] = [{ wch: 18 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, ws1, '汇总');

    const detail = [['日期', '成员', '任务', '状态', '完成时间', '文字', '点赞', '照片数']];
    data.rows.forEach((r) => detail.push([
      r.date, r.nickname, r.task, STATUS_TEXT[r.status] || r.status, r.time || '', r.note || '', r.likes || 0, r.photos || 0
    ]));
    const ws2 = XLSX.utils.aoa_to_sheet(detail);
    ws2['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 16 }, { wch: 8 }, { wch: 10 }, { wch: 40 }, { wch: 8 }, { wch: 8 }];
    XLSX.utils.book_append_sheet(wb, ws2, '明细');

    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  /* ---------------- DOCX ---------------- */
  async function buildDocx(data, lib) {
    const D = lib || root.docx;
    if (!D) throw new Error('docx 未加载');
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, ImageRun } = D;

    const cell = (text, opts) => new TableCell({
      width: { size: 1, type: WidthType.PERCENTAGE },
      children: [new Paragraph({
        alignment: (opts && opts.right) ? AlignmentType.RIGHT : AlignmentType.LEFT,
        children: [new TextRun({ text: String(text == null ? '' : text), size: 18, color: (opts && opts.muted) ? '64748B' : '0F172A' })]
      })]
    });

    const table = (head, rows) => new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ children: head.map((h, i) => cell(h, { muted: true, right: i > 0 })) }),
        ...rows.map((r) => new TableRow({ children: r.map((c, i) => cell(c, { right: i > 0 })) }))
      ]
    });

    const m = data.metrics;
    const children = [
      new Paragraph({ text: `${data.meta.groupName} · 打卡总结`, heading: HeadingLevel.TITLE }),
      new Paragraph({
        children: [new TextRun({
          text: `${data.meta.rangeStart} 至 ${data.meta.rangeEnd}　共 ${data.meta.days} 天　${data.meta.members} 人　${data.meta.tasks} 项任务`,
          size: 19, color: '64748B'
        })]
      }),
      new Paragraph({ text: '' }),
      new Paragraph({
        children: [
          new TextRun({ text: `按时率 ${pct(m.rateOnTime)}　`, bold: true, size: 26 }),
          new TextRun({ text: `完成率 ${pct(m.rateDone)}　`, bold: true, size: 26 }),
          new TextRun({ text: `未完成 ${m.missing} 条`, bold: true, size: 26 })
        ]
      })
    ];

    if (data.summary) {
      children.push(new Paragraph({ text: '总结', heading: HeadingLevel.HEADING_1 }));
      data.summary.split('\n').filter(Boolean).forEach((line) => {
        children.push(new Paragraph({ children: [new TextRun({ text: line, size: 21 })], spacing: { after: 120 } }));
      });
    }

    children.push(new Paragraph({ text: '成员', heading: HeadingLevel.HEADING_1 }));
    children.push(table(
      ['成员', '应完成', '按时', '补记', '未完成', '按时率'],
      m.perMember.map((x) => [x.name, x.expected, x.done, x.late, x.missing, pct(x.rate)])
    ));

    children.push(new Paragraph({ text: '任务', heading: HeadingLevel.HEADING_1 }));
    children.push(table(
      ['任务', '截止', '应完成', '完成', '完成率'],
      m.perTask.map((x) => [x.title, x.deadline, x.expected, x.done, pct(x.rate)])
    ));

    const photos = (data.photos || []).slice(0, 4).filter((p) => p.bytes);
    if (photos.length) {
      children.push(new Paragraph({ text: '照片', heading: HeadingLevel.HEADING_1 }));
      photos.forEach((p) => {
        try {
          children.push(new Paragraph({
            children: [new ImageRun({
              data: p.bytes,
              transformation: { width: Math.min(360, p.width || 320), height: Math.min(270, p.height || 240) },
              type: 'jpg'
            })]
          }));
          if (p.caption) children.push(new Paragraph({ children: [new TextRun({ text: p.caption, size: 16, color: '94A3B8' })] }));
        } catch (e) { /* 单张图片失败不影响整份文档 */ }
      });
    }

    children.push(new Paragraph({ text: '明细', heading: HeadingLevel.HEADING_1 }));
    children.push(table(
      ['日期', '成员', '任务', '状态', '时间', '点赞'],
      data.rows.slice(0, 300).map((r) => [r.date, r.nickname, r.task, STATUS_TEXT[r.status] || r.status, r.time || '', r.likes || 0])
    ));

    children.push(new Paragraph({
      children: [new TextRun({ text: `由「小事打卡」生成 · ${data.meta.generatedAt}`, size: 16, color: '94A3B8' })]
    }));

    const doc = new Document({ sections: [{ children }] });
    return await Packer.toBlob(doc);
  }

  /* ---------------- ICS 日历 ---------------- */
  function icsEsc(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  // RFC 5545 每行不超过 75 字节，超出折行；按字符切，避免把一个汉字劈开
  function fold(line) {
    const enc = new TextEncoder();
    const parts = [];
    let cur = '';
    let bytes = 0;
    for (const ch of line) {
      const b = enc.encode(ch).length;
      if (bytes + b > 73) {
        parts.push(cur);
        cur = ' ';
        bytes = 1;
      }
      cur += ch;
      bytes += b;
    }
    parts.push(cur);
    return parts.join('\r\n');
  }

  function icsStamp(dt) {
    return dt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  // data: { groupName, today: 'YYYY-MM-DD', baseUrl, tasks: [{id,title,deadline_time,reminder_offset}] }
  function buildIcs(data) {
    const out = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//xiaoshi-checkin//xiaoshi checkin//CN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:' + icsEsc('小事打卡 · ' + data.groupName),
      'X-WR-TIMEZONE:Asia/Shanghai'
    ];

    (data.tasks || []).forEach((t) => {
      const hm = String(t.deadline_time || '23:59').slice(0, 5);
      const start = new Date(`${data.today}T${hm}:00+08:00`);
      if (isNaN(start.getTime())) return;
      const end = new Date(start.getTime() + 30 * 60000);
      const offset = Number(t.reminder_offset || 0);
      out.push(
        'BEGIN:VEVENT',
        'UID:' + (t.id || 'x') + '@xiaoshi-checkin',
        'DTSTAMP:' + icsStamp(new Date()),
        'DTSTART:' + icsStamp(start),
        'DTEND:' + icsStamp(end),
        'RRULE:FREQ=DAILY',
        'SUMMARY:' + icsEsc(`${t.title || '打卡'}（${hm} 截止）`),
        'DESCRIPTION:' + icsEsc(`每天 ${hm} 前打卡。打开：${data.baseUrl}`)
      );
      if (data.baseUrl) out.push('URL:' + data.baseUrl);
      if (offset > 0) {
        out.push(
          'BEGIN:VALARM',
          'TRIGGER:-PT' + offset + 'M',
          'ACTION:DISPLAY',
          'DESCRIPTION:' + icsEsc(`该打卡了：${t.title || '打卡'}`),
          'END:VALARM'
        );
      }
      out.push('END:VEVENT');
    });

    out.push('END:VCALENDAR');
    return out.map(fold).join('\r\n') + '\r\n';
  }

  const api = { buildCsv, buildHtml, buildXlsx, buildDocx, buildIcs, pct, STATUS_TEXT };
  root.CheckinExport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
