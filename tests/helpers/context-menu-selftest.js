const assert = require("node:assert/strict");

async function runContextMenuSelftest({ win, app, setZoom, contextMenu, contextMenuEvents, closeContextMenu, readPrefs, listSkins, applySkin }) {
  const js = (code) => win.webContents.executeJavaScript(code);
  let phase = "renderer startup";
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (label, check) => {
    phase = label;
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await wait(50);
    }
    throw new Error(`Native menu self-test timed out: ${label}`);
  };
  const stateIs = (expression, expected, label = expression) => until(label, async () =>
    (await js(`JSON.stringify(${expression})`)) === JSON.stringify(expected));
  let presentation = null;
  const present = async (label, trigger) => {
    phase = label;
    const before = contextMenuEvents();
    await trigger();
    await until(`${label}: native menu-will-show`, () => contextMenuEvents().shown > before.shown);
    const menu = contextMenu();
    assert.ok(menu, "the shown menu remains available");
    presentation = { closedBefore: before.closed };
    return menu;
  };
  const close = async () => {
    phase = "close menu";
    assert.ok(presentation, "a native menu was shown before closing");
    const { closedBefore } = presentation;
    closeContextMenu();
    await until("native menu-will-close", () => contextMenuEvents().closed > closedBefore);
    assert.equal(contextMenu(), null);
    presentation = null;
  };
  const open = async (selector, right = false) => {
    const menu = await present(`open ${selector}`, () => js(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error('Menu trigger is absent');
      const rect = node.getBoundingClientRect();
      const input = { bubbles: true, cancelable: true, button: ${right ? 2 : 0},
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      if (${right}) node.dispatchEvent(new MouseEvent('mousedown', { ...input, buttons: 2 }));
      node.dispatchEvent(new MouseEvent(${JSON.stringify(right ? "contextmenu" : "click")}, {
        ...input,
      }));
    })()`));
    console.log("Opened native menu", selector);
    assert.equal(await js(`document.querySelectorAll('#webamp-context-menu').length`), 0, "no clipped HTML popup");
    return menu;
  };
  const choose = async (menu, label) => {
    const item = menu.items.find((entry) => entry.label === label);
    assert.ok(item?.enabled, `enabled menu action: ${label}`);
    item.click();
    console.log("Selected native menu action", label);
    await close();
  };
  win.webContents.once("did-finish-load", async () => {
    try {
      await until("renderer startup", () => js(`Boolean(window.__webamp && document.querySelector('#main-window'))`));
      console.log("Native menu renderer ready");
      const green = listSkins().find((skin) => skin.hasEq && /green/i.test(skin.name));
      if (green) { applySkin(green); await wait(1000); }
      for (const zoom of [1, 2, 3]) {
        setZoom(zoom, { save: false });
        await wait(250);
        const size = win.getContentSize();
        const menu = await open("#main-window", true);
        assert.ok(menu.items.find((item) => item.label === "Skins").submenu.items.length, "skins submenu is populated");
        assert.deepEqual(win.getContentSize(), size, "menus do not enlarge the transparent window");
        await close();
      }
      let menu = await open("#option-context");
      const options = menu.items.find((item) => item.label === "Options").submenu;
      await choose(options, "Time Remaining");
      await stateIs("window.__webamp.store.getState().media.timeMode", "REMAINING");
      menu = await open("#button-o");
      assert.equal(menu.items.find((item) => item.label === "Time Remaining").checked, true);
      await choose(menu, "Double-size Skin");
      await stateIs("window.__webamp.store.getState().display.doubled", true);
      menu = await open("#main-window", true);
      await choose(menu.items.find((item) => item.label === "Options").submenu, "Double-size Skin");
      await stateIs("window.__webamp.store.getState().display.doubled", false);

      menu = await open("#main-window", true);
      const wasOpen = menu.items.find((item) => item.label === "Shelf").checked;
      await choose(menu, "Shelf");
      await stateIs("window.__webamp.store.getState().windows.genWindows.playlist.open", !wasOpen);
      if (wasOpen) {
        await choose(await open("#main-window", true), "Shelf");
        await stateIs("window.__webamp.store.getState().windows.genWindows.playlist.open", true);
      }

      menu = await open("#playlist-remove-menu");
      assert.equal(menu.items[0].enabled, false);
      await close();
      // Keep a second shelf row so a stale selection cannot silently erase it.
      let nextFixtureId = 9900000;
      const addFixture = () => js(`(() => {
        const store = window.__webamp.store;
        const id = ${nextFixtureId++};
        window.__bridge.quiet++;
        try {
          store.dispatch({ type: 'ADD_TRACK_FROM_URL', id, url: 'shelf:test', defaultName: 'Menu fixture', duration: null });
          store.dispatch({ type: 'SET_MEDIA_TAGS', id, title: 'Menu fixture', artist: null, album: null });
        } finally { window.__bridge.quiet--; }
      })()`);
      await addFixture();
      await until("shelf rows rendered", () => js(`document.querySelectorAll('#playlist-window .playlist-track-titles .track-cell').length === 2`));
      const order = await js(`window.__webamp.store.getState().playlist.trackOrder`);
      const drags = await js(`window.__actions.filter(action => action === 'DRAG_SELECTED').length`);
      await open("#playlist-window .playlist-track-titles .track-cell", true);
      await close();
      // Model a native popup consuming mouseup: move over the next row with no
      // buttons pressed. This is controlled DOM input, not a physical macOS test.
      phase = "right-click drag guard";
      await js(`new Promise(resolve => {
        const rows = document.querySelectorAll('#playlist-window .playlist-track-titles .track-cell');
        const rect = rows[1].getBoundingClientRect();
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 0,
          clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })`);
      assert.deepEqual(await js(`window.__webamp.store.getState().playlist.trackOrder`), order, "right-click without DOM mouseup must not reorder the shelf");
      assert.equal(await js(`window.__actions.filter(action => action === 'DRAG_SELECTED').length`), drags, "right-click must not arm Webamp's drag handler");
      await js(`window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 2 }))`);
      await js(`window.__webamp.store.dispatch({ type: 'CLICKED_TRACK', index: 0 })`);
      await choose(await open("#playlist-remove-menu"), "Remove Selected");
      await stateIs("window.__webamp.store.getState().playlist.trackOrder.length", 1);
      menu = await open("#playlist-remove-menu");
      assert.equal(menu.items[1].enabled, false, "crop disabled after removing selection");
      await close();
      await addFixture();
      await js(`(() => {
        const store = window.__webamp.store;
        store.dispatch({ type: 'CLICKED_TRACK', index: 0 });
        store.dispatch({ type: 'REMOVE_TRACKS', ids: [store.getState().playlist.trackOrder[0]] });
      })()`);
      menu = await open("#playlist-remove-menu");
      assert.equal(menu.items[1].enabled, false, "removed Webamp IDs are not a selection");
      // Even a delayed selection callback must not crop against removed IDs.
      menu.items[1].click();
      await close();
      await js(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      assert.equal(await js(`window.__webamp.store.getState().playlist.trackOrder.length`), 1);
      await until("playing metadata available", () => js(`window.__webamp.store.getState().playlist.currentTrack != null`));
      const currentTrack = await js(`window.__webamp.store.getState().playlist.currentTrack`);
      await choose(await open("#playlist-list-menu"), "Clear Shelf");
      await stateIs("window.__webamp.store.getState().playlist.trackOrder.length", 0);
      assert.equal(await js(`window.__webamp.store.getState().playlist.currentTrack`), currentTrack, "clear preserves playing metadata");
      await until("cleared shelf persisted", () => readPrefs().shelf?.length === 0);
      menu = await open("#playlist-add-menu");
      assert.deepEqual(menu.items.map((item) => item.label), ["Add Music Link from Clipboard"]);
      await close();
      menu = await open("#playlist-misc-menu");
      assert.ok(menu.items.find((item) => item.label === "Sort Alphabetically"));
      await close();
      menu = await open("#playlist-list-menu");
      assert.equal(menu.items[0].enabled, false);
      await close();

      const stops = await js(`window.__actions.filter(action => action === 'STOP').length`);
      menu = await open("#main-window", true);
      await choose(menu.items.find(item => item.label === "Playback").submenu, "Stop");
      await stateIs("window.__actions.filter(action => action === 'STOP').length", stops + 1, "Stop uses the media bridge");

      await present("keyboard menu", () => js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))`));
      const beforeReload = contextMenuEvents();
      win.webContents.reload();
      await until("reload closes native menu", () => contextMenuEvents().closed > beforeReload.closed && !contextMenu());
      console.log("PASS native menus: native show/close events, 1x/2x/3x, nested options, checks, double size, shelf edits, missing-mouseup drag guard, keyboard, reload cleanup");
      app.exit(0);
    } catch (error) {
      console.error("FAIL native menus:", phase, error.message);
      app.exit(1);
    }
  });
}

module.exports = { runContextMenuSelftest };
