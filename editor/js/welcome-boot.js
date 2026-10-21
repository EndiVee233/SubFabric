/* 首屏防闪：在欢迎界面初始化前先把 App 壳藏起来。
 *
 * 为什么单独一个同步脚本：`project.js` 是 ES module，等它执行时浏览器可能已经
 * 画过一帧主页；首次启动就会“闪一下主页再弹欢迎”。这里在 <head> 里同步判断，
 * 有 `sf-welcome-v1` 就什么都不做；没有就挂 `sf-welcome-pending`，CSS 先隐藏
 * #app / 侧栏 / 顶栏，等 welcomeShow 或 initWelcome 完成后由 project.js 摘掉。
 *
 * 存储不可用（隐私模式）时按“首次启动”处理；真正保存失败时欢迎界面会提示。
 */
(function () {
  try {
    if (!localStorage.getItem('sf-welcome-v1')) {
      document.documentElement.classList.add('sf-welcome-pending');
    }
  } catch (e) {
    document.documentElement.classList.add('sf-welcome-pending');
  }
})();
