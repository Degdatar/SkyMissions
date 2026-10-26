(() => {
  const notice = document.getElementById('mission-notice');
  const title = document.getElementById('mission-title');
  const points = document.getElementById('mission-points');
  const queue = [];
  let noticeTimer = 0;
  let hideTimer = 0;

  function hideNativeView() {
    if (window.skyrim && typeof window.skyrim.skyos_skymissions_mission_notice_hide === 'function') {
      window.skyrim.skyos_skymissions_mission_notice_hide('');
    } else if (typeof window.skyos_skymissions_mission_notice_hide === 'function') {
      window.skyos_skymissions_mission_notice_hide('');
    }
  }

  function finishNotice() {
    notice.classList.remove('visible');
    if (hideTimer) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      hideTimer = 0;
      notice.hidden = true;
      if (queue.length) showNext();
      else hideNativeView();
    }, 360);
  }

  function showNext() {
    if (!queue.length) {
      finishNotice();
      return;
    }
    const message = queue.shift();
    title.textContent = message.title;
    points.textContent = `+${message.reward.toLocaleString()}`;
    notice.className = `position-${message.position} design-${message.design} size-${message.size}`;
    notice.hidden = false;
    window.requestAnimationFrame(() => notice.classList.add('visible'));
    if (noticeTimer) window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      noticeTimer = 0;
      finishNotice();
    }, Math.max(0, message.durationMs - 360));
  }

  window.SkyMissionNotice = {
    show(missionTitle, reward, design, position, durationMs, size) {
      const safeTitle = String(missionTitle || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 160);
      const safeReward = Math.max(0, Math.floor(Number(reward) || 0));
      if (!safeTitle || !safeReward) return;
      const safeDesign = ['dwemer-ledger', 'frost-seal', 'quest-banner', 'minimal'].includes(String(design)) ? String(design) : 'dwemer-ledger';
      const safePosition = ['top-left', 'top-center', 'top-right', 'center-left', 'center-center', 'center-right', 'bottom-left', 'bottom-center', 'bottom-right'].includes(String(position)) ? String(position) : 'top-center';
      const safeDuration = Math.min(3000, Math.max(500, Math.floor(Number(durationMs) || 1500)));
      const safeSize = ['large', 'standard', 'compact'].includes(String(size)) ? String(size) : 'large';
      if (queue.length >= 8) queue.shift();
      queue.push({ title: safeTitle, reward: safeReward, design: safeDesign, position: safePosition, durationMs: safeDuration, size: safeSize });
      if (notice.hidden) showNext();
    }
  };
})();
