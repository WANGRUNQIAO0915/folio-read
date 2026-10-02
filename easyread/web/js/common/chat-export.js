(function (PR) {
  "use strict";
  PR.exportChatMessages = function (data) {
    if (Array.isArray(data)) return data;
    if (!data) return [];
    if (Array.isArray(data.threads)) return data.threads.flatMap((thread) =>
      (thread.messages || []).map((message, i) => Object.assign({}, message, {
        threadTitle: thread.title || "新对话", threadStart: i === 0,
      })));
    return data.messages || [];
  };
})(window.PR);
