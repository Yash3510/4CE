// Opens the Parda panel from the toolbar button: Chrome side panel, Firefox sidebar.
export default defineBackground(() => {
  const chromeSidePanel = (globalThis as any).chrome?.sidePanel;
  if (chromeSidePanel?.setPanelBehavior) {
    chromeSidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    return;
  }
  const action = (browser as any).action ?? (browser as any).browserAction;
  action?.onClicked.addListener(() => (browser as any).sidebarAction?.toggle());
});
