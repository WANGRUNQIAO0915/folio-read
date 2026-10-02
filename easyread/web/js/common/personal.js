/* Personal terminology and reusable, evidence-led reading cards. */
(function (PR) {
  "use strict";
  PR.settingsTabs.personal = {
    render(s) {
      const p = s.personal || { profile: "general", goal: "", glossary: [] };
      const options = Object.entries(s.profiles || {}).map(([k, v]) => [k, v.name]);
      return '<p class="set-lead">让后续论文沿用你的术语和阅读目标。自定义术语优先于领域预设和论文生成的术语。</p>' +
        '<label class="field"><span>阅读方向</span><select class="input" id="personalProfile">' + PR.opt(options, p.profile) + '</select></label>' +
        '<label class="field" style="margin-top:16px"><span>研究目标 / 希望重点理解什么</span><textarea class="input" id="personalGoal" rows="3" maxlength="3000" placeholder="例如：比较不同方法的假设、数据要求和验证方式">' + PR.esc(p.goal) + '</textarea></label>' +
        '<label class="field" style="margin-top:16px"><span>自用术语：每行 English = 中文</span><textarea class="input" id="personalTerms" rows="7" placeholder="land cover = 土地覆盖&#10;standard error = 标准误差">' +
        PR.esc(p.glossary.map((g) => g.en + " = " + g.zh).join("\n")) + '</textarea></label>' +
        '<p class="hint">保存后用于新翻译与 AI 解释；已译正文需要重译才会采用新术语。论文笔记里的“插入精读卡”会提供对应阅读框架。</p>';
    },
    sync(s, dlg) {
      const profile = dlg.querySelector("#personalProfile");
      if (!profile) return;
      const glossary = dlg.querySelector("#personalTerms").value.split("\n").filter((l) => l.trim()).map((line, i) => {
        const parts = line.match(/^\s*(.+?)\s*(?:=|\t)\s*(.+?)\s*$/);
        if (!parts) throw new Error("术语第 " + (i + 1) + " 行请写成 English = 中文");
        return { en: parts[1].trim(), zh: parts[2].trim() };
      });
      s.personal = { profile: profile.value, goal: dlg.querySelector("#personalGoal").value, glossary };
    },
  };

  PR.paperCardTemplate = async function () {
    let profile = "general";
    if (PR.store && PR.store.mode === "server") {
      profile = (await PR.api("/api/personal")).preferences.profile;
    }
    const meta = PR.state.paper.meta || {};
    const out = ["# 精读卡", "", "论文：" + (meta.title_zh || meta.title_en || ""),
      "DOI / 链接：" + (meta.doi || meta.url || (meta.arxiv ? "https://arxiv.org/abs/" + meta.arxiv : "待补")), "",
      "填写规则：每个结论标注原文页码、图表或公式；区分作者结论、我的判断与待核实内容。", "",
      "## 1. 作者要解决什么问题", "- 问题：", "- 现有方法的具体缺口：", "- 原文依据（页 / 段）：", "",
      "## 2. 数据与研究对象", "- 数据来源、样本量与范围：", "- 预处理、纳入 / 排除标准：", "- 原文依据：", "",
      "## 3. 方法为什么能解决问题", "- 核心机制与假设：", "- 基线、消融、独立验证：", "- 复现所需数据 / 代码 / 参数：", "",
      "## 4. 关键结果与证据", "- 结果（数字、单位、不确定性）：", "- 对应页码 / 图表 / 公式：", "- 作者的解释：", "",
      "## 5. 局限与适用边界", "- 作者承认的局限（原文依据）：", "- 我的判断（与作者结论分开）：", "- 仍需核实：", "",
      "## 6. 与我的研究有什么关系", "- 可以借鉴的做法与前提：", "- 不适用的部分：", "- 下一步行动：", ""];
    if (profile === "geo") out.push("## 领域检查：遥感 / GIS", "- 空间与时间尺度、分辨率：", "- 地面参考数据与时空独立性：", "- 云掩膜 / 重采样 / 投影处理：", "- 空间泄漏、区域迁移与外推风险：", "");
    if (profile === "methods") out.push("## 领域检查：方法与统计", "- 独立样本与重复测量：", "- 效应量与置信区间：", "- 验证集隔离、数据泄漏与敏感性分析：", "- 假设与结论的对应关系：", "");
    return out.map((line) => /^#{1,4} /.test(line) ? line + "\n" : line).join("\n");
  };
})(window.PR);
