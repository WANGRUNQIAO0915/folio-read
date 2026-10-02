/* Shared study controls; keep reader and research interactions consistent. */
(function(PR){
  'use strict';
  PR.studyUI = function(root){
    root.innerHTML = `<div class="study-shell">
<aside class="study-sidebar" aria-label="问答记录与研究主题">
  <details class="history-disclosure"><summary>问答记录</summary><div class="sidebar-content">
    <button class="btn line new-study" id="newStudy">＋ 新提问</button>
    <div id="studyHistory" class="history-list"></div>
  </div></details>
  <div class="topic-region"><h2>我的主题</h2><div id="studyTopics" class="topic-list"></div><button class="btn line" data-new-topic>＋ 新建主题</button></div>
</aside>
<div class="study-content"><div class="study-context">
<label class="field paper-picker"><span>关联论文</span><select class="input" id="studyPaper"></select></label>
<a id="backPaper" class="btn line" href="/">阅读论文 →</a>
<details class="analysis-options"><summary>模型设置</summary><div class="options-body">
<label class="field"><span>分析模型</span><select class="input" id="studyModel"></select></label>
<p class="hint">使用已有模型设置；图像会发送给支持图片的模型。</p>
</div></details>
</div>
<div class="topic-picker">
<label class="field"><span>研究主题</span><select class="input" id="studyTopic"><option value="">请选择主题</option></select></label>
<details class="new-topic"><summary>新建主题</summary><div class="options-body">
<label class="field"><span>主题名称</span><input class="input" id="topicTitle" maxlength="160" placeholder="例如：偏好优化方法比较"></label>
<label class="field"><span>研究问题</span><textarea class="input" id="topicQuestion" rows="3"></textarea></label>
<div class="study-actions"><button class="btn accent" id="createTopic">创建主题</button><button class="btn line" id="cancelTopic">取消</button></div></div></details>
</div>    <div id="studyNotice" role="status" class="notice" hidden></div>
    <section class="study-form" id="analysisForm">
      <h2 id="modeTitle">有原文依据的全文问答</h2><p id="modeHint" class="hint"></p>
      <div id="questionScopeControls" hidden><label class="field"><span>回答范围</span><select class="input" id="questionScope"><option value="paper">当前论文</option><option value="library">整个资料库 · 优先使用收藏文章</option></select></label></div>
      <details id="knowledgeControls" class="retrieval-options" hidden><summary>资料范围与回答方式</summary>
        <label class="field"><span>资料范围</span><select class="input" id="knowledgeCategory"><option value="">全部收藏文章</option></select></label>
        <div class="knowledge-options"><label><input type="checkbox" id="knowledgeNotes" checked>检索我的笔记</label><label><input type="checkbox" id="knowledgeGeneral" checked>资料不足时允许库外补充</label></div>
        <p class="hint">先查收藏文章；论文依据、个人笔记和库外补充会分别标明。新导入或修改的资料在下次提问时自动更新。</p>
      </details>
      <div id="overviewControls" hidden><label class="field"><span>阅读层次</span><select class="input" id="studyLevel"><option value="overview">先看研究问题、方法、结果与边界</option><option value="section">深入一个章节或原文页</option></select></label><label class="field" id="sectionField" hidden><span>选择章节 / 原文页</span><select class="input" id="studySection"></select></label></div>
      <div id="visualControls" hidden><label class="field"><span>选择图表或公式</span><select class="input" id="studyAsset"></select></label><div id="assetFormula"></div><p id="assetCaption" class="hint"></p><div class="crop-stage" id="cropStage" hidden><img id="visualImage" alt="所选图表或公式所在的原图"><div id="cropBox" hidden></div></div><p id="imageHint" class="hint"></p><button id="clearCrop" class="btn sm line" hidden>清除框选</button></div>
      <div id="compareControls" hidden><p>选择 2–8 篇论文，围绕一个共同问题比较。</p><div id="comparePapers" class="compare-papers"></div></div>
      <label class="field"><span id="questionLabel">你想理解什么？</span><textarea class="input" id="studyQuestion" rows="3" maxlength="4000" placeholder="例如：作者的方法依赖哪些假设？实验是否支持这些假设？"></textarea></label>
      <div class="study-actions"><button class="btn accent" id="startStudy">开始分析</button><button class="btn line" id="stopStudy" hidden>停止</button><span id="taskStatus" role="status" class="hint"></span></div>
    </section>
    <section id="studyResult" aria-label="分析结果"></section>
    <section id="researchPanel" hidden>
      <div class="topic-heading"><h2 id="activeTopicTitle">研究记录</h2><p id="topicDescription" class="hint">选一个研究主题，收集证据、判断和待核实问题。</p></div>
      <div class="study-actions"><button class="btn line" id="collectNotes">收集当前论文的笔记</button><a class="btn line" id="exportObsidian">导出 Obsidian 包</a><a class="btn line" id="exportMarkdown">导出 Markdown</a><a class="btn line" id="exportRIS">导出 Zotero RIS</a></div>
      <details class="manual-note"><summary>添加判断或待核实问题</summary><p class="hint">记录会关联所选论文。</p><label class="field"><span>记录类型</span><select class="input" id="recordKind"><option value="judgment">我的判断</option><option value="question">待核实问题</option></select></label><label class="field"><span>内容</span><textarea class="input" id="recordText" rows="3"></textarea></label><button class="btn accent" id="addRecord">保存记录</button></details>
      <nav id="recordFilters" class="record-filters" aria-label="研究记录筛选"></nav><div id="researchRecords"></div>
      <details class="zotero-bridge"><summary>关联当前论文的 Zotero 条目</summary><p class="hint">在本机 Zotero 中搜索已有条目。关联只保存对应关系；RIS 导出可带阅读笔记，导入时请核对是否与已有条目重复。</p><div class="study-actions"><input class="input" id="zoteroQuery" placeholder="DOI 或论文标题"><button class="btn line" id="zoteroSearch">搜索 Zotero</button></div><div id="zoteroMatches"></div><div id="zoteroLinked"></div></details>
    </section></div></div>
`;
  };
})(window.PR);
