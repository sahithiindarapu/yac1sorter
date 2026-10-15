(function () {
  let currentFilter = "all"; // "all" | "multiplier" | "fixed"
  let currentSort = "none";  // "none" | "fixed-first" | "mult-first" | "value-desc" | "value-asc"
  let isAutoLoading = false;
  let autoLoadTimer = null;
  let stallCount = 0;
  let lastTileCount = 0;

  function logDebug(msg, data = "") {
    console.log(`%c[C1-Ext] ${msg}`, "color: #004977; font-weight: bold;", data);
  }

  // Inject a bridge into the MAIN page world so we can call React's internal __reactProps$.onClick directly
  function injectMainWorldBridge() {
    if (document.getElementById("c1-ext-main-bridge")) return;
    const script = document.createElement("script");
    script.id = "c1-ext-main-bridge";
    script.textContent = `
      window.addEventListener("c1-ext-trigger-view-more", function() {
        const buttons = Array.from(document.querySelectorAll("button"));
        const btn = buttons.find(b => {
          const t = (b.textContent || "").replace(/\\s+/g, " ").trim().toLowerCase();
          return t === "view more offers" || t.includes("view more offers");
        });

        if (!btn) {
          console.log("[C1-Ext MainWorld] View More Offers button not found.");
          return;
        }

        // Scroll button into viewport so any IntersectionObserver triggers
        btn.scrollIntoView({ behavior: "instant", block: "center" });

        // Method 1: Call React's internal __reactProps$ onClick handler directly!
        const reactPropsKey = Object.keys(btn).find(k => k.startsWith("__reactProps$"));
        const reactFiberKey = Object.keys(btn).find(k => k.startsWith("__reactFiber$"));

        console.log("[C1-Ext MainWorld] Found button. React keys:", { reactPropsKey, reactFiberKey, disabled: btn.disabled });

        if (reactPropsKey && btn[reactPropsKey] && typeof btn[reactPropsKey].onClick === "function") {
          console.log("[C1-Ext MainWorld] Invoking React __reactProps$.onClick directly");
          try {
            btn[reactPropsKey].onClick({
              target: btn,
              currentTarget: btn,
              preventDefault: () => {},
              stopPropagation: () => {},
              nativeEvent: new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
            });
            return;
          } catch (err) {
            console.warn("[C1-Ext MainWorld] __reactProps$.onClick error, falling back to native click:", err);
          }
        }

        // Method 2: Main-world native event sequence
        const opts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
        btn.dispatchEvent(new PointerEvent("pointerdown", opts));
        btn.dispatchEvent(new MouseEvent("mousedown", opts));
        btn.dispatchEvent(new PointerEvent("pointerup", opts));
        btn.dispatchEvent(new MouseEvent("mouseup", opts));
        btn.click();
      });
    `;
    (document.head || document.documentElement).appendChild(script);
  }

  // 1. Parse an offer tile's reward text & merchant name
  function parseTileData(tileEl) {
    const img = tileEl.querySelector("img[alt]");
    const merchant = img ? (img.getAttribute("alt") || "").trim() : "";
    const text = tileEl.innerText || "";

    const multMatch = text.match(/(?:Up to\s+)?([\d,]+(?:\.\d+)?)\s*[xX]\s*miles/i);
    if (multMatch) {
      return {
        type: "multiplier",
        tier: 1,
        value: parseFloat(multMatch[1].replace(/,/g, "")),
        merchant
      };
    }

    const fixedMilesMatch = text.match(/(?:Up to\s+)?([\d,]+)\s*miles/i);
    if (fixedMilesMatch) {
      return {
        type: "fixed",
        tier: 2,
        value: parseFloat(fixedMilesMatch[1].replace(/,/g, "")),
        merchant
      };
    }

    const fixedCashMatch = text.match(/(?:Up to\s+)?\$\s*([\d,]+(?:\.\d+)?)/i);
    if (fixedCashMatch) {
      return {
        type: "fixed",
        tier: 2,
        value: parseFloat(fixedCashMatch[1].replace(/,/g, "")),
        merchant
      };
    }

    const pctMatch = text.match(/(?:Up to\s+)?([\d.]+)\s*%\s*(?:back|cash)?/i);
    if (pctMatch) {
      return {
        type: "multiplier",
        tier: 1,
        value: parseFloat(pctMatch[1]),
        merchant
      };
    }

    return { type: "other", tier: 0, value: 0, merchant };
  }

  // 2. Locate the main Offers Grid container
  function getMainFeedGrid() {
    const firstTile = document.querySelector('div[data-testid^="feed-tile-"]');
    return firstTile ? firstTile.parentElement : null;
  }

  // 3. Unpack hidden tiles inside horizontal carousels ONLY when sorting/filtering
  function flattenCarousels(grid) {
    const carousels = Array.from(grid.querySelectorAll('div[data-testid^="feed-tile-carousel-"]'));
    carousels.forEach(carousel => {
      if (carousel.dataset.c1HiddenCarousel === "true") return;
      const innerStandardTiles = Array.from(carousel.querySelectorAll(".standard-tile"));
      innerStandardTiles.forEach(standardTile => {
        const originalWrapper = standardTile.parentElement;
        if (originalWrapper) {
          originalWrapper.className = "flex w-full h-full cursor-pointer";
          originalWrapper.style.cssText = "height: 146px; width: 100%; min-width: 100%; display: flex; flex: 1 1 auto;";
          originalWrapper.setAttribute("data-testid", "feed-tile-extracted");
          grid.appendChild(originalWrapper);
        }
      });
      carousel.style.display = "none";
      carousel.dataset.c1HiddenCarousel = "true";
    });
  }

  // 4. Apply Filter + Sort to the main feed grid
  function applyFilterAndSort() {
    const grid = getMainFeedGrid();
    if (!grid) return;

    // IMPORTANT: Never mutate the grid while auto-loading is actively running,
    // otherwise React's virtual DOM loses track of where to append new batches!
    if (isAutoLoading) return;

    if (currentFilter !== "all" || currentSort !== "none") {
      flattenCarousels(grid);
    }

    const tiles = Array.from(grid.children).filter(
      el => el.dataset.c1HiddenCarousel !== "true"
    );

    const parsedTiles = tiles.map((el, index) => {
      if (el.dataset.c1OrigIndex === undefined) {
        el.dataset.c1OrigIndex = String(index);
        el.dataset.c1OrigStyle = el.getAttribute("style") || "";
      }
      return {
        el,
        origIndex: parseInt(el.dataset.c1OrigIndex, 10),
        data: parseTileData(el)
      };
    });

    if (currentFilter === "all" && currentSort === "none") {
      parsedTiles.sort((a, b) => a.origIndex - b.origIndex);
      parsedTiles.forEach(item => {
        item.el.setAttribute("style", item.el.dataset.c1OrigStyle);
        item.el.style.display = "flex";
        grid.appendChild(item.el);
      });
      updateCounterBadge(parsedTiles.length, parsedTiles.length);
      return;
    }

    const seenMerchants = new Set();
    let visibleCount = 0;

    parsedTiles.forEach(item => {
      const { type, merchant } = item.data;

      let matchesFilter = true;
      if (currentFilter === "fixed") {
        matchesFilter = type === "fixed";
      } else if (currentFilter === "multiplier") {
        matchesFilter = type === "multiplier";
      } else {
        matchesFilter = type === "fixed" || type === "multiplier";
      }

      const merchantKey = merchant.toLowerCase();
      if (matchesFilter && merchantKey) {
        if (seenMerchants.has(merchantKey)) {
          matchesFilter = false;
        } else {
          seenMerchants.add(merchantKey);
        }
      }

      item.visible = matchesFilter;
    });

    if (currentSort !== "none") {
      parsedTiles.sort((a, b) => {
        if (a.visible !== b.visible) return a.visible ? -1 : 1;

        if (currentSort === "fixed-first") {
          if (b.data.tier !== a.data.tier) return b.data.tier - a.data.tier;
          return b.data.value - a.data.value;
        }
        if (currentSort === "mult-first") {
          if (b.data.tier !== a.data.tier) return a.data.tier - b.data.tier;
          return b.data.value - a.data.value;
        }
        if (currentSort === "value-desc") {
          return b.data.value - a.data.value;
        }
        if (currentSort === "value-asc") {
          return a.data.value - b.data.value;
        }
        return a.origIndex - b.origIndex;
      });
    }

    parsedTiles.forEach(item => {
      if (item.visible) {
        visibleCount++;
        item.el.style.gridArea = "auto";
        item.el.style.height = "146px";
        item.el.style.display = "flex";
      } else {
        item.el.style.display = "none";
      }
      grid.appendChild(item.el);
    });

    updateCounterBadge(visibleCount, parsedTiles.length);
  }

  function updateCounterBadge(visible, total) {
    const badge = document.getElementById("c1-ext-count-badge");
    if (badge) {
      badge.textContent = `Showing ${visible} of ${total} loaded`;
    }
  }

  // 5. Find the native "View More Offers" button
  function findNativeViewMoreButton() {
    const allButtons = Array.from(document.querySelectorAll("button"));
    return allButtons.find(btn => {
      if (btn.id && btn.id.startsWith("c1-ext-")) return false;
      const text = (btn.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      return text === "view more offers" || text.includes("view more offers");
    }) || null;
  }

  // 6. Infinite Auto-Loader using the Main World React Bridge
  function toggleAutoLoad() {
    injectMainWorldBridge();

    const topLoadBtn = document.getElementById("c1-ext-autoload-top");
    const bottomLoadBtn = document.getElementById("c1-ext-autoload-bottom");

    const setButtonsState = (text, bg) => {
      [topLoadBtn, bottomLoadBtn].forEach(btn => {
        if (!btn) return;
        btn.textContent = text;
        btn.style.backgroundColor = bg;
      });
    };

    if (isAutoLoading) {
      logDebug("Stopped auto-loading.");
      isAutoLoading = false;
      clearTimeout(autoLoadTimer);
      setButtonsState("⏬ Load All Offers", "#004977");
      applyFilterAndSort();
      return;
    }

    // If user already sorted/mutated the DOM before clicking Load All, reset grid order first
    // so React doesn't choke when appending new tiles
    const grid = getMainFeedGrid();
    if (grid && (currentFilter !== "all" || currentSort !== "none")) {
      logDebug("Temporarily restoring original DOM order while React loads new batches...");
      const savedFilter = currentFilter;
      const savedSort = currentSort;
      currentFilter = "all";
      currentSort = "none";
      applyFilterAndSort();
      currentFilter = savedFilter;
      currentSort = savedSort;
    }

    isAutoLoading = true;
    stallCount = 0;
    lastTileCount = 0;
    setButtonsState("⏹️ Stop Loading...", "#d03027");

    function step() {
      if (!isAutoLoading) return;

      const currentGrid = getMainFeedGrid();
      const loadedCount = currentGrid
        ? currentGrid.querySelectorAll('div[data-testid^="feed-tile-"]').length
        : 0;

      updateCounterBadge(loadedCount, loadedCount);

      const viewMoreBtn = findNativeViewMoreButton();

      if (!viewMoreBtn) {
        stallCount++;
        logDebug(`"View More Offers" button not in DOM (check ${stallCount}/6). Loaded tiles: ${loadedCount}`);
        if (stallCount < 6) {
          autoLoadTimer = setTimeout(step, 1000);
        } else {
          isAutoLoading = false;
          logDebug(`All offers loaded! Total: ${loadedCount}`);
          setButtonsState(`✅ All Loaded (${loadedCount})`, "#25810e");
          applyFilterAndSort();
        }
        return;
      }

      if (loadedCount === lastTileCount) {
        stallCount++;
      } else {
        stallCount = 0;
        lastTileCount = loadedCount;
      }

      setButtonsState(`⏹️ Stop (${loadedCount} loaded...)`, "#d03027");
      logDebug(`Triggering View More Offers via MainWorld Bridge (tiles: ${loadedCount})`);

      // Fire custom event to main world script to invoke React's __reactProps$.onClick
      window.dispatchEvent(new CustomEvent("c1-ext-trigger-view-more"));

      autoLoadTimer = setTimeout(step, 1300);
    }

    step();
  }

  // 7. Create 3-Way Segmented Toggle for Filter (All | X / % | Fixed Miles)
  function createFilterToggleGroup(onSelectChange) {
    const group = document.createElement("div");
    group.id = "c1-ext-filter-group";
    Object.assign(group.style, {
      display: "inline-flex",
      alignItems: "center",
      backgroundColor: "#e2e8f0",
      borderRadius: "9999px",
      padding: "3px",
      gap: "2px"
    });

    const modes = [
      { id: "all", label: "All" },
      { id: "multiplier", label: "X / %" },
      { id: "fixed", label: "Fixed Miles" }
    ];

    const buttons = {};

    function updateToggleStyles() {
      modes.forEach(m => {
        const btn = buttons[m.id];
        const active = currentFilter === m.id;
        Object.assign(btn.style, {
          backgroundColor: active ? "#004977" : "transparent",
          color: active ? "#ffffff" : "#334155",
          boxShadow: active ? "0 1px 3px rgba(0,0,0,0.15)" : "none"
        });
      });
    }

    modes.forEach(mode => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = mode.label;
      Object.assign(btn.style, {
        border: "none",
        borderRadius: "9999px",
        padding: "6px 14px",
        fontSize: "13px",
        fontWeight: "600",
        cursor: "pointer",
        transition: "all 0.15s ease"
      });

      btn.addEventListener("click", () => {
        currentFilter = mode.id;
        updateToggleStyles();
        onSelectChange(currentFilter);
      });

      buttons[mode.id] = btn;
      group.appendChild(btn);
    });

    updateToggleStyles();
    return group;
  }

  function createSortDropdown(id, options, initialValue) {
    const select = document.createElement("select");
    select.id = id;
    Object.assign(select.style, {
      display: "inline-flex",
      alignItems: "center",
      borderRadius: "9999px",
      border: "1px solid #d4d4d4",
      backgroundColor: "#ffffff",
      color: "#141414",
      padding: "7px 14px",
      fontSize: "13px",
      fontWeight: "600",
      cursor: "pointer",
      outline: "none"
    });

    options.forEach(opt => {
      const optionEl = document.createElement("option");
      optionEl.value = opt.value;
      optionEl.textContent = opt.label;
      if (opt.value === initialValue) optionEl.selected = true;
      select.appendChild(optionEl);
    });

    return select;
  }

  // 8. Inject UI Controls
  function injectExtensionUI() {
    injectMainWorldBridge();

    if (!document.getElementById("c1-ext-toolbar")) {
      const spans = Array.from(document.querySelectorAll("button span"));
      const categorySpan = spans.find(s => (s.innerText || "").trim() === "Category");
      const categoryBtnWrapper = categorySpan ? categorySpan.closest("button")?.parentElement : null;

      if (categoryBtnWrapper && categoryBtnWrapper.parentElement) {
        const categoryRow = categoryBtnWrapper.parentElement;

        const toolbar = document.createElement("div");
        toolbar.id = "c1-ext-toolbar";
        Object.assign(toolbar.style, {
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "12px",
          marginBottom: "10px",
          padding: "8px 12px",
          backgroundColor: "#f8fafc",
          border: "1px solid #e2e8f0",
          borderRadius: "10px"
        });

        const sortSelect = createSortDropdown(
          "c1-ext-sort-select",
          [
            { value: "none", label: "⇅ Sort: Default" },
            { value: "fixed-first", label: "⚡ Sort: Fixed 1st → Highest X" },
            { value: "mult-first", label: "🚀 Sort: Highest X 1st → Fixed" },
            { value: "value-desc", label: "🔥 Sort: High → Low" },
            { value: "value-asc", label: "📉 Sort: Low → High" }
          ],
          currentSort
        );

        const filterToggle = createFilterToggleGroup((selectedFilter) => {
          if (selectedFilter !== "all" && currentSort === "none") {
            currentSort = "value-desc";
            sortSelect.value = "value-desc";
          }
          applyFilterAndSort();
        });

        sortSelect.addEventListener("change", (e) => {
          currentSort = e.target.value;
          applyFilterAndSort();
        });

        const topLoadBtn = document.createElement("button");
        topLoadBtn.id = "c1-ext-autoload-top";
        topLoadBtn.type = "button";
        topLoadBtn.textContent = "⏬ Load All Offers";
        Object.assign(topLoadBtn.style, {
          borderRadius: "9999px",
          border: "none",
          backgroundColor: "#004977",
          color: "#ffffff",
          padding: "7px 16px",
          fontSize: "13px",
          fontWeight: "600",
          cursor: "pointer"
        });
        topLoadBtn.addEventListener("click", toggleAutoLoad);

        const countBadge = document.createElement("span");
        countBadge.id = "c1-ext-count-badge";
        Object.assign(countBadge.style, {
          marginLeft: "auto",
          fontSize: "13px",
          fontWeight: "600",
          color: "#525252"
        });
        const grid = getMainFeedGrid();
        countBadge.textContent = `Showing ${grid ? grid.children.length : 0} loaded`;

        toolbar.appendChild(filterToggle);
        toolbar.appendChild(sortSelect);
        toolbar.appendChild(topLoadBtn);
        toolbar.appendChild(countBadge);

        categoryRow.parentElement.insertBefore(toolbar, categoryRow);
      }
    }

    // Floating Bottom Pill (mounted directly on document.body so we never break React's Virtual DOM siblings!)
    if (!document.getElementById("c1-ext-autoload-bottom") && getMainFeedGrid()) {
      const bottomLoadBtn = document.createElement("button");
      bottomLoadBtn.id = "c1-ext-autoload-bottom";
      bottomLoadBtn.type = "button";
      bottomLoadBtn.textContent = "⏬ Load All Offers";
      Object.assign(bottomLoadBtn.style, {
        position: "fixed",
        bottom: "20px",
        right: "20px",
        zIndex: "99999",
        padding: "12px 20px",
        backgroundColor: "#004977",
        color: "#ffffff",
        border: "none",
        borderRadius: "9999px",
        fontWeight: "600",
        fontSize: "14px",
        cursor: "pointer",
        boxShadow: "0 4px 12px rgba(0,0,0,0.25)"
      });

      bottomLoadBtn.addEventListener("click", toggleAutoLoad);
      document.body.appendChild(bottomLoadBtn);
    }
  }

  const observer = new MutationObserver(() => {
    injectExtensionUI();
  });

  observer.observe(document.body, { childList: true, subtree: true });
  injectExtensionUI();
})();