/* WW Journey Tracker v2 — Pure Vanilla JS */

(function () {
  "use strict";

  // ─── Constants ───────────────────────────────────────────────
  const STORAGE_KEY = "ww_tracker_v2_state";
  const FLEX_WEEKLY = 35;
  const CIRCUMFERENCE = 2 * Math.PI * 52; // ≈ 326.73

  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const DAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  // ─── State ───────────────────────────────────────────────────
  let state = null;
  let selectedDate = null; // YYYY-MM-DD for Daily tab
  let addTargetDate = null; // which day the add-modal will log to
  let pendingFood = null; // food being added via qty modal
  let editingFoodId = null;
  let scannerActive = false;
  let html5QrCode = null;
  let barcodeDetector = null;

  // ─── Date helpers (America/New_York) ─────────────────────────
  function getNYDate() {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = fmt.formatToParts(new Date());
    const y = parts.find((p) => p.type === "year").value;
    const m = parts.find((p) => p.type === "month").value;
    const d = parts.find((p) => p.type === "day").value;
    return `${y}-${m}-${d}`;
  }

  function parseDate(str) {
    const [y, m, d] = str.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function formatDate(str) {
    const dt = parseDate(str);
    return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }

  function addDays(str, n) {
    const dt = parseDate(str);
    dt.setDate(dt.getDate() + n);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const d = String(dt.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function getWeekStart(dateStr, weekStartDay) {
    const dt = parseDate(dateStr);
    const dow = dt.getDay(); // 0=Sun
    let diff = dow - weekStartDay;
    if (diff < 0) diff += 7;
    return addDays(dateStr, -diff);
  }

  function getWeekRangeLabel(weekStart) {
    const end = addDays(weekStart, 6);
    const s = parseDate(weekStart);
    const e = parseDate(end);
    const opts = { month: "short", day: "numeric" };
    return `${s.toLocaleDateString("en-US", opts)} – ${e.toLocaleDateString("en-US", opts)}`;
  }

  // ─── Points ──────────────────────────────────────────────────
  function calculatePoints(calories, fat, fiber) {
    let points = calories / 50 + fat / 12 - fiber / 5;
    points = Math.ceil(points * 0.9);
    return Math.max(0, points);
  }

  function foodPoints(food) {
    if (food.manualPoints != null && food.manualPoints !== "" && !isNaN(food.manualPoints)) {
      return Math.max(0, Math.round(Number(food.manualPoints)));
    }
    return calculatePoints(
      Number(food.calories) || 0,
      Number(food.fat) || 0,
      Number(food.fiber) || 0
    );
  }

  function dailyTarget() {
    const w = Number(state.profile.weight) || 150;
    const mod = { sedentary: 0, moderate: 2, active: 4 }[state.profile.activity] || 0;
    return Math.round(w / 10 + 6 + mod);
  }

  // ─── Flex Points ─────────────────────────────────────────────
  function ensureFlexWeek() {
    const today = getNYDate();
    const ws = getWeekStart(today, state.profile.weekStartDay);
    if (state.flexPoints.currentWeekStart !== ws) {
      state.flexPoints.currentWeekStart = ws;
      recalculateFlexUsed();
    }
  }

  function recalculateFlexUsed() {
    const ws = state.flexPoints.currentWeekStart;
    const target = dailyTarget();
    let used = 0;
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i);
      const day = state.days[d];
      if (!day) continue;
      const dayPts = day.entries.reduce((s, e) => s + e.points * e.qty, 0);
      if (dayPts > target) used += dayPts - target;
    }
    state.flexPoints.used = used;
  }

  function flexRemaining() {
    ensureFlexWeek();
    return FLEX_WEEKLY - state.flexPoints.used;
  }

  // ─── Persistence ─────────────────────────────────────────────
  function defaultState() {
    // DEFAULT_FOODS comes from food.js — only used on first install; never overwrites saved library
    const starterFoods =
      typeof DEFAULT_FOODS !== "undefined" && Array.isArray(DEFAULT_FOODS) && DEFAULT_FOODS.length
        ? DEFAULT_FOODS.map((f, i) => ({ ...f, id: f.id || i + 1 }))
        : [];
    return {
      profile: {
        weight: 150,
        activity: "sedentary",
        weekStartDay: 1, // Monday
      },
      foods: starterFoods,
      days: {},
      flexPoints: {
        currentWeekStart: getWeekStart(getNYDate(), 1),
        used: 0,
      },
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const def = defaultState();
        state = {
          profile: { ...def.profile, ...(parsed.profile || {}) },
          foods: Array.isArray(parsed.foods) ? parsed.foods : def.foods,
          days: parsed.days && typeof parsed.days === "object" ? parsed.days : {},
          flexPoints: { ...def.flexPoints, ...(parsed.flexPoints || {}) },
        };
      } else {
        state = defaultState();
      }
    } catch (e) {
      console.warn("Failed to load state, using defaults", e);
      state = defaultState();
    }
    ensureFlexWeek();
    recalculateFlexUsed();
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error("Save failed", e);
      toast("Could not save data", "error");
    }
  }

  // ─── Day helpers ─────────────────────────────────────────────
  function ensureDay(dateStr) {
    if (!state.days[dateStr]) {
      state.days[dateStr] = { date: dateStr, entries: [] };
    }
    return state.days[dateStr];
  }

  function dayPoints(dateStr) {
    const day = state.days[dateStr];
    if (!day) return 0;
    return day.entries.reduce((s, e) => s + e.points * e.qty, 0);
  }

  function dayMacros(dateStr) {
    const day = state.days[dateStr];
    if (!day) {
      return { protein: 0, fiber: 0, sodium: 0, saturated: 0, carbs: 0, sugar: 0, fat: 0, calories: 0 };
    }
    return day.entries.reduce(
      (acc, e) => {
        const q = e.qty || 1;
        acc.protein += (e.protein || 0) * q;
        acc.fiber += (e.fiber || 0) * q;
        acc.sodium += (e.sodium || 0) * q;
        acc.saturated += (e.saturated || 0) * q;
        acc.carbs += (e.carbs || 0) * q;
        acc.sugar += (e.sugar || 0) * q;
        acc.fat += (e.fat || 0) * q;
        acc.calories += (e.calories || 0) * q;
        return acc;
      },
      { protein: 0, fiber: 0, sodium: 0, saturated: 0, carbs: 0, sugar: 0, fat: 0, calories: 0 }
    );
  }

  function fmtMacro(val, unit) {
    if (val == null || val === 0) return "—";
    if (unit === "mg") return Math.round(val) + "mg";
    if (unit === "kcal") return String(Math.round(val));
    return (Math.round(val * 10) / 10) + "g";
  }

  function nextFlexResetLabel() {
    const next = addDays(state.flexPoints.currentWeekStart, 7);
    const dt = parseDate(next);
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  // ─── UI Helpers ──────────────────────────────────────────────
  function $(id) {
    return document.getElementById(id);
  }

  function toast(msg, type) {
    const el = $("toast");
    el.textContent = msg;
    el.className = "toast show" + (type ? " " + type : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      el.classList.remove("show");
    }, 2800);
  }

  function openModal(id) {
    $(id).classList.add("open");
  }

  function closeModal(id) {
    $(id).classList.remove("open");
  }

  function closeAllModals() {
    document.querySelectorAll(".modal-overlay.open").forEach((m) => m.classList.remove("open"));
    stopScanner();
  }

  function confirmDialog(title, msg) {
    return new Promise((resolve) => {
      $("confirm-title").textContent = title;
      $("confirm-msg").textContent = msg;
      openModal("modal-confirm");
      const ok = () => {
        cleanup();
        resolve(true);
      };
      const cancel = () => {
        cleanup();
        resolve(false);
      };
      function cleanup() {
        closeModal("modal-confirm");
        $("confirm-ok").removeEventListener("click", ok);
        $("confirm-cancel").removeEventListener("click", cancel);
      }
      $("confirm-ok").addEventListener("click", ok);
      $("confirm-cancel").addEventListener("click", cancel);
    });
  }

  // ─── Progress Ring ───────────────────────────────────────────
  function setRing(el, points, target) {
    const ratio = target > 0 ? Math.min(points / target, 1.15) : 0;
    const offset = CIRCUMFERENCE * (1 - Math.min(ratio, 1));
    el.style.strokeDasharray = CIRCUMFERENCE;
    el.style.strokeDashoffset = offset;
    if (points > target) {
      el.style.stroke = "#c0392b";
    } else if (points / target > 0.85) {
      el.style.stroke = "var(--gold)";
    } else {
      el.style.stroke = "var(--green)";
    }
  }

  // ─── Render: Today ───────────────────────────────────────────
  function renderToday() {
    const today = getNYDate();
    const pts = dayPoints(today);
    const target = dailyTarget();
    const flex = flexRemaining();
    const macros = dayMacros(today);

    $("today-points").textContent = Math.round(pts * 10) / 10;
    $("today-target").textContent = "/ " + target;
    setRing($("today-ring"), pts, target);

    const flexEl = $("today-flex");
    flexEl.textContent = Math.round(flex);
    flexEl.classList.toggle("negative", flex < 0);
    $("today-week-range").textContent = getWeekRangeLabel(state.flexPoints.currentWeekStart);

    $("fact-used").textContent = Math.round(pts);
    $("fact-remain").textContent = Math.max(0, Math.round(target - pts));
    $("fact-flex").textContent = Math.round(flex);
    $("fact-reset").textContent = nextFlexResetLabel();

    $("header-date").textContent = formatDate(today);

    renderEntries("today-entries", today);
  }

  // ─── Render: Entries list ────────────────────────────────────
  function applyQtyChange(dateStr, idx, newQty, containerId) {
    const day = ensureDay(dateStr);
    if (!day.entries[idx]) return;
    newQty = Math.round(Number(newQty) * 100) / 100;
    if (isNaN(newQty) || newQty <= 0) {
      day.entries.splice(idx, 1);
    } else {
      day.entries[idx].qty = newQty;
    }
    recalculateFlexUsed();
    saveState();
    if (containerId === "today-entries") renderToday();
    else renderDaily();
  }

  function renderEntries(containerId, dateStr) {
    const container = $(containerId);
    const day = state.days[dateStr];
    if (!day || day.entries.length === 0) {
      container.innerHTML = '<div class="empty-state">No foods logged yet</div>';
      return;
    }

    container.innerHTML = day.entries
      .map((e, idx) => {
        const totalPts = Math.round(e.points * e.qty * 10) / 10;
        return `
        <div class="entry-card" data-idx="${idx}">
          <div class="entry-info">
            <div class="entry-name">${esc(e.name)}</div>
            <div class="entry-meta">${esc(e.servingSize || "")}${e.qty !== 1 ? " × " + e.qty : ""}</div>
          </div>
          <div class="entry-points">${totalPts}</div>
          <div class="entry-stepper">
            <button type="button" data-action="minus" data-idx="${idx}" aria-label="Decrease">−</button>
            <button type="button" class="entry-qty" data-action="edit-qty" data-idx="${idx}" aria-label="Edit quantity">${e.qty}</button>
            <button type="button" data-action="plus" data-idx="${idx}" aria-label="Increase">+</button>
          </div>
        </div>`;
      })
      .join("");

    container.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        const action = btn.dataset.action;
        const day = ensureDay(dateStr);
        if (!day.entries[idx]) return;

        if (action === "edit-qty") {
          const current = day.entries[idx].qty;
          const input = document.createElement("input");
          input.type = "number";
          input.className = "entry-qty-input";
          input.min = "0.25";
          input.step = "0.25";
          input.value = current;
          input.setAttribute("aria-label", "Quantity");
          btn.replaceWith(input);
          input.focus();
          input.select();

          const commit = () => {
            const val = Number(input.value);
            applyQtyChange(dateStr, idx, val, containerId);
          };
          input.addEventListener("blur", commit);
          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              input.blur();
            } else if (e.key === "Escape") {
              input.removeEventListener("blur", commit);
              if (containerId === "today-entries") renderToday();
              else renderDaily();
            }
          });
          return;
        }

        if (action === "plus") {
          applyQtyChange(dateStr, idx, day.entries[idx].qty + 0.25, containerId);
        } else if (action === "minus") {
          applyQtyChange(dateStr, idx, day.entries[idx].qty - 0.25, containerId);
        }
      });
    });
  }

  // ─── Render: Library ─────────────────────────────────────────
  function renderLibrary(filter) {
    const q = (filter || "").toLowerCase().trim();
    const grid = $("library-grid");
    let foods = state.foods.slice().sort((a, b) => a.name.localeCompare(b.name));
    if (q) {
      foods = foods.filter(
        (f) =>
          f.name.toLowerCase().includes(q) ||
          (f.brand || "").toLowerCase().includes(q) ||
          (f.barcode || "").includes(q)
      );
    }

    if (foods.length === 0) {
      grid.innerHTML = '<div class="empty-state">No foods found</div>';
      return;
    }

    grid.innerHTML = foods
      .map((f) => {
        const pts = foodPoints(f);
        const img = f.imageUrl
          ? `<img class="food-card-img" src="${esc(f.imageUrl)}" alt="" loading="lazy" onerror="this.style.display='none'" />`
          : `<div class="food-card-img"></div>`;
        const macros = [];
        if (f.protein) macros.push(`P ${f.protein}g`);
        if (f.carbs) macros.push(`C ${f.carbs}g`);
        if (f.fat != null) macros.push(`F ${f.fat}g`);
        return `
        <div class="food-card" data-id="${f.id}">
          ${img}
          <div class="food-card-info">
            <div class="food-card-name">${esc(f.name)}</div>
            ${f.brand ? `<div class="food-card-brand">${esc(f.brand)}</div>` : ""}
            <div class="food-card-meta">${esc(f.servingSize || "")}${macros.length ? " · " + macros.join(" · ") : ""}</div>
          </div>
          <div class="food-card-pts">${pts}</div>
        </div>`;
      })
      .join("");

    grid.querySelectorAll(".food-card").forEach((card) => {
      card.addEventListener("click", () => openEditFood(Number(card.dataset.id)));
    });
  }
    // ─── Render: Daily ───────────────────────────────────────────
  function renderDateSlider() {
    const slider = $("date-slider");
    const today = getNYDate();
    const dates = new Set();
    for (let i = -21; i <= 7; i++) dates.add(addDays(today, i));
    Object.keys(state.days).forEach((d) => dates.add(d));
    const sorted = Array.from(dates).sort();

    if (!selectedDate) selectedDate = today;

    slider.innerHTML = sorted
      .map((d) => {
        const dt = parseDate(d);
        const isToday = d === today;
        const isSel = d === selectedDate;
        const hasData = state.days[d] && state.days[d].entries.length > 0;
        return `
        <div class="date-chip${isSel ? " selected" : ""}${isToday ? " today" : ""}" data-date="${d}">
          <div class="dow">${DAY_NAMES[dt.getDay()]}</div>
          <div class="dom">${dt.getDate()}</div>
          ${isToday ? '<div class="today-badge">Today</div>' : hasData ? '<div class="today-badge">•</div>' : ""}
        </div>`;
      })
      .join("");

    slider.querySelectorAll(".date-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        selectedDate = chip.dataset.date;
        renderDaily();
        chip.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      });
    });

    requestAnimationFrame(() => {
      const sel = slider.querySelector(".date-chip.selected");
      if (sel) sel.scrollIntoView({ inline: "center", block: "nearest" });
    });
  }

  function renderDaily() {
    if (!selectedDate) selectedDate = getNYDate();
    renderDateSlider();

    const pts = dayPoints(selectedDate);
    const target = dailyTarget();
    const macros = dayMacros(selectedDate);

    $("daily-points").textContent = Math.round(pts * 10) / 10;
    $("daily-target").textContent = "/ " + target;
    setRing($("daily-ring"), pts, target);
    $("daily-date-label").textContent = formatDate(selectedDate);

    $("dfact-protein").textContent = fmtMacro(macros.protein, "g");
    $("dfact-fiber").textContent = fmtMacro(macros.fiber, "g");
    $("dfact-sodium").textContent = fmtMacro(macros.sodium, "mg");
    $("dfact-sat").textContent = fmtMacro(macros.saturated, "g");
    $("dfact-carbs").textContent = fmtMacro(macros.carbs, "g");
    $("dfact-sugar").textContent = fmtMacro(macros.sugar, "g");
    $("dfact-fat").textContent = fmtMacro(macros.fat, "g");
    $("dfact-calories").textContent = fmtMacro(macros.calories, "kcal");

    renderEntries("daily-entries", selectedDate);
  }

  // ─── Render: Settings ────────────────────────────────────────
  function renderSettings() {
    $("set-weight").value = state.profile.weight;
    $("set-activity").value = state.profile.activity;
    $("set-weekstart").value = state.profile.weekStartDay;
    $("set-target-preview").textContent = dailyTarget();
  }

  function updateTargetPreview() {
    const w = Number($("set-weight").value) || 150;
    const act = $("set-activity").value;
    const mod = { sedentary: 0, moderate: 2, active: 4 }[act] || 0;
    $("set-target-preview").textContent = Math.round(w / 10 + 6 + mod);
  }

  // ─── Food Modal ──────────────────────────────────────────────
  function openNewFood(prefill) {
    editingFoodId = null;
    $("food-modal-title").textContent = "New Food";
    clearFoodForm();
    if (prefill) fillFoodForm(prefill);
    updateFoodPointsPreview();
    openModal("modal-food");
  }

  function openEditFood(id) {
    const food = state.foods.find((f) => f.id === id);
    if (!food) return;
    editingFoodId = id;
    $("food-modal-title").textContent = "Edit Food";
    fillFoodForm(food);
    updateFoodPointsPreview();
    openModal("modal-food");
  }

  function clearFoodForm() {
    $("f-id").value = "";
    $("f-name").value = "";
    $("f-brand").value = "";
    $("f-serving").value = "";
    $("f-cal").value = "";
    $("f-fat").value = "";
    $("f-fiber").value = "";
    $("f-protein").value = "";
    $("f-carbs").value = "";
    $("f-sugar").value = "";
    $("f-sodium").value = "";
    $("f-manual").value = "";
    $("f-barcode").value = "";
    $("f-image").value = "";
    $("f-saturated").value = "";
  }

  function fillFoodForm(f) {
    $("f-id").value = f.id || "";
    $("f-name").value = f.name || "";
    $("f-brand").value = f.brand || "";
    $("f-serving").value = f.servingSize || "";
    $("f-cal").value = f.calories != null ? f.calories : "";
    $("f-fat").value = f.fat != null ? f.fat : "";
    $("f-fiber").value = f.fiber != null ? f.fiber : "";
    $("f-protein").value = f.protein != null ? f.protein : "";
    $("f-carbs").value = f.carbs != null ? f.carbs : "";
    $("f-sugar").value = f.sugar != null ? f.sugar : "";
    $("f-sodium").value = f.sodium != null ? f.sodium : "";
    $("f-manual").value = f.manualPoints != null ? f.manualPoints : "";
    $("f-barcode").value = f.barcode || "";
    $("f-image").value = f.imageUrl || "";
    $("f-saturated").value = f.saturated != null ? f.saturated : "";
  }

  function updateFoodPointsPreview() {
    const cal = Number($("f-cal").value) || 0;
    const fat = Number($("f-fat").value) || 0;
    const fiber = Number($("f-fiber").value) || 0;
    const manual = $("f-manual").value;
    let pts;
    if (manual !== "" && !isNaN(manual)) {
      pts = Math.max(0, Math.round(Number(manual)));
    } else {
      pts = calculatePoints(cal, fat, fiber);
    }
    $("f-points-preview").textContent = pts;
  }

  function saveFood() {
    const name = $("f-name").value.trim();
    if (!name) {
      if (editingFoodId != null) {
        confirmDialog("Delete Food?", "Clearing the name will permanently remove this food from your library.").then((ok) => {
          if (ok) {
            state.foods = state.foods.filter((f) => f.id !== editingFoodId);
            saveState();
            closeModal("modal-food");
            renderLibrary($("library-search").value);
            toast("Food deleted", "success");
          }
        });
      } else {
        toast("Name is required", "error");
      }
      return;
    }

    const serving = $("f-serving").value.trim();
    if (!serving) {
      toast("Serving size is required", "error");
      return;
    }

    const cal = Number($("f-cal").value);
    const fat = Number($("f-fat").value);
    const fiber = Number($("f-fiber").value);
    if (isNaN(cal) || isNaN(fat) || isNaN(fiber)) {
      toast("Calories, fat, and fiber are required", "error");
      return;
    }

    const manualVal = $("f-manual").value;
    const food = {
      id: editingFoodId || Date.now(),
      name,
      brand: $("f-brand").value.trim() || undefined,
      barcode: $("f-barcode").value || undefined,
      servingSize: serving,
      calories: cal,
      fat,
      fiber,
      protein: $("f-protein").value !== "" ? Number($("f-protein").value) : undefined,
      carbs: $("f-carbs").value !== "" ? Number($("f-carbs").value) : undefined,
      sugar: $("f-sugar").value !== "" ? Number($("f-sugar").value) : undefined,
      sodium: $("f-sodium").value !== "" ? Number($("f-sodium").value) : undefined,
      saturated: $("f-saturated").value !== "" ? Number($("f-saturated").value) : undefined,
      manualPoints: manualVal !== "" && !isNaN(manualVal) ? Number(manualVal) : undefined,
      imageUrl: $("f-image").value || undefined,
    };

    if (editingFoodId != null) {
      const idx = state.foods.findIndex((f) => f.id === editingFoodId);
      if (idx >= 0) state.foods[idx] = food;
    } else {
      state.foods.push(food);
    }

    saveState();
    closeModal("modal-food");
    renderLibrary($("library-search").value);
    toast(editingFoodId ? "Food updated" : "Food added", "success");
  }

  // ─── Add to Day ──────────────────────────────────────────────
  function openAddModal(dateStr) {
    addTargetDate = dateStr || getNYDate();
    $("add-search").value = "";
    renderAddResults("");
    openModal("modal-add");
    setTimeout(() => $("add-search").focus(), 300);
  }

  function renderAddResults(filter) {
    const q = (filter || "").toLowerCase().trim();
    const results = $("add-results");
    let foods = state.foods.slice().sort((a, b) => a.name.localeCompare(b.name));
    if (q) {
      foods = foods.filter(
        (f) =>
          f.name.toLowerCase().includes(q) ||
          (f.brand || "").toLowerCase().includes(q)
      );
    }
    foods = foods.slice(0, 40);

    if (foods.length === 0) {
      results.innerHTML = '<div class="empty-state">No matching foods</div>';
      return;
    }

    results.innerHTML = foods
      .map((f) => {
        const pts = foodPoints(f);
        return `
        <div class="add-result-item" data-id="${f.id}">
          <div class="add-result-name">${esc(f.name)}${f.brand ? " · " + esc(f.brand) : ""}</div>
          <div class="add-result-pts">${pts} pts</div>
        </div>`;
      })
      .join("");

    results.querySelectorAll(".add-result-item").forEach((item) => {
      item.addEventListener("click", () => {
        const food = state.foods.find((f) => f.id === Number(item.dataset.id));
        if (food) openQtyModal(food);
      });
    });
  }

  function openQtyModal(food) {
    pendingFood = food;
    $("qty-title").textContent = "Add to " + formatDate(addTargetDate);
    $("qty-name").textContent = food.name;
    $("qty-points").textContent = foodPoints(food) + " pts each";
    $("qty-val").value = 1;
    closeModal("modal-add");
    openModal("modal-qty");
  }

  function confirmQty() {
    if (!pendingFood) return;
    let qty = Number($("qty-val").value);
    if (isNaN(qty) || qty <= 0) {
      toast("Enter a valid quantity", "error");
      return;
    }
    qty = Math.round(qty * 100) / 100;

    const pts = foodPoints(pendingFood);
    const day = ensureDay(addTargetDate);
    day.entries.push({
      foodId: pendingFood.id,
      name: pendingFood.name,
      points: pts,
      qty,
      calories: pendingFood.calories,
      fat: pendingFood.fat,
      fiber: pendingFood.fiber,
      protein: pendingFood.protein,
      carbs: pendingFood.carbs,
      sodium: pendingFood.sodium,
      sugar: pendingFood.sugar,
      saturated: pendingFood.saturated,
      servingSize: pendingFood.servingSize,
    });

    recalculateFlexUsed();
    saveState();
    closeModal("modal-qty");
    pendingFood = null;

    if (addTargetDate === getNYDate()) renderToday();
    if (selectedDate === addTargetDate) renderDaily();
    toast("Added " + qty + " × " + day.entries[day.entries.length - 1].name, "success");
  }

  // ─── Barcode Scanner ─────────────────────────────────────────
  let scanFromFoodModal = false;

  function setScannerStatus(msg) {
    const el = $("scanner-status");
    if (el) el.textContent = msg || "";
  }

  function startScanner(fromFoodModal) {
    scanFromFoodModal = !!fromFoodModal;
    scannerActive = true;
    $("scanner-overlay").classList.add("active");
    setScannerStatus("Starting camera…");

    requestAnimationFrame(() => {
      setTimeout(() => {
        if (!scannerActive) return;

        if (typeof Html5Qrcode !== "undefined") {
          startHtml5Scanner();
          return;
        }

        if ("BarcodeDetector" in window && navigator.mediaDevices) {
          startNativeScanner();
          return;
        }

        setScannerStatus("Camera not supported — use Photo or enter manually");
        toast("Live scan not supported. Use Photo or enter barcode manually.", "error");
      }, 150);
    });
  }

  function startHtml5Scanner() {
    const region = $("html5-qr-region");
    if (!region) {
      setScannerStatus("Scanner UI missing");
      return;
    }
    region.innerHTML = "";

    if (html5QrCode) {
      try {
        html5QrCode.stop().catch(() => {});
      } catch (_) {}
      html5QrCode = null;
    }

    try {
      html5QrCode = new Html5Qrcode("html5-qr-region", { verbose: false });
    } catch (err) {
      console.error("Html5Qrcode init failed", err);
      setScannerStatus("Could not start scanner");
      toast("Scanner failed to start", "error");
      return;
    }

    const config = {
      fps: 12,
      qrbox: function (viewfinderWidth, viewfinderHeight) {
        const w = Math.floor(viewfinderWidth * 0.85);
        const h = Math.floor(Math.min(160, viewfinderHeight * 0.35));
        return { width: w, height: h };
      },
      aspectRatio: 1.777,
      disableFlip: false,
      experimentalFeatures: {
        useBarCodeDetectorIfSupported: true,
      },
    };

    html5QrCode
      .start(
        { facingMode: "environment" },
        config,
        (decodedText) => {
          if (!scannerActive) return;
          scannerActive = false;
          setScannerStatus("Found: " + decodedText);
          stopScanner();
          handleBarcode(decodedText, scanFromFoodModal);
        },
        () => {}
      )
      .then(() => {
        setScannerStatus("Point at a barcode");
        const shaded = document.getElementById("qr-shaded-region");
        if (shaded) shaded.style.border = "none";
      })
      .catch((err) => {
        console.warn("html5-qrcode start failed", err);
        const msg = String(err && err.message ? err.message : err);
        if (/NotAllowedError|Permission|denied/i.test(msg)) {
          setScannerStatus("Camera permission denied");
          toast("Allow camera access in browser settings, or use Photo", "error");
        } else if (/NotFoundError|DevicesNotFound|no camera/i.test(msg)) {
          setScannerStatus("No camera found");
          toast("No camera found — use Photo or enter manually", "error");
        } else if (/Secure|HTTPS|secure context/i.test(msg)) {
          setScannerStatus("HTTPS required for camera");
          toast("Camera needs HTTPS (or localhost). Use Photo instead.", "error");
        } else {
          setScannerStatus("Camera failed — try Photo");
          toast("Camera failed. Try Photo or enter barcode manually.", "error");
        }
      });
  }

  async function startNativeScanner() {
    try {
      barcodeDetector = new BarcodeDetector({
        formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"],
      });

      const region = $("html5-qr-region");
      region.innerHTML = "";
      const video = document.createElement("video");
      video.setAttribute("playsinline", "true");
      video.setAttribute("autoplay", "true");
      video.style.width = "100%";
      video.style.height = "100%";
      video.style.objectFit = "cover";
      region.appendChild(video);

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      setScannerStatus("Point at a barcode");

      const scanLoop = async () => {
        if (!scannerActive) return;
        try {
          if (video.readyState >= 2) {
            const codes = await barcodeDetector.detect(video);
            if (codes.length > 0) {
              const code = codes[0].rawValue;
              scannerActive = false;
              setScannerStatus("Found: " + code);
              stopScanner();
              handleBarcode(code, scanFromFoodModal);
              return;
            }
          }
        } catch (_) {}
        if (scannerActive) requestAnimationFrame(scanLoop);
      };
      requestAnimationFrame(scanLoop);
    } catch (err) {
      console.warn("Native scanner failed", err);
      setScannerStatus("Camera failed — use Photo");
      toast("Camera access denied or unavailable. Use Photo.", "error");
    }
  }

  function stopScanner() {
    scannerActive = false;
    $("scanner-overlay").classList.remove("active");
    setScannerStatus("");

    if (html5QrCode) {
      const inst = html5QrCode;
      html5QrCode = null;
      try {
        inst
          .stop()
          .then(() => {
            try {
              inst.clear();
            } catch (_) {}
          })
          .catch(() => {});
      } catch (_) {}
    }

    const region = $("html5-qr-region");
    if (region) {
      region.querySelectorAll("video").forEach((v) => {
        if (v.srcObject) {
          v.srcObject.getTracks().forEach((t) => t.stop());
          v.srcObject = null;
        }
      });
      region.innerHTML = "";
    }
  }

  function openPhotoScan() {
    const input = $("scan-file-input");
    if (!input) return;
    input.value = "";
    input.click();
  }

  async function handlePhotoFile(file) {
    if (!file) return;
    setScannerStatus("Reading photo…");
    toast("Decoding barcode from photo…");

    if (typeof Html5Qrcode === "undefined") {
      toast("Barcode library not loaded", "error");
      return;
    }

    let tempId = "html5-qr-temp";
    let temp = document.getElementById(tempId);
    if (!temp) {
      temp = document.createElement("div");
      temp.id = tempId;
      temp.style.display = "none";
      document.body.appendChild(temp);
    }

    try {
      const scanner = new Html5Qrcode(tempId, { verbose: false });
      const decoded = await scanner.scanFile(file, true);
      try {
        scanner.clear();
      } catch (_) {}
      if (decoded) {
        stopScanner();
        handleBarcode(decoded, scanFromFoodModal);
      } else {
        setScannerStatus("No barcode found in photo");
        toast("No barcode found — try again or enter manually", "error");
      }
    } catch (err) {
      console.warn("scanFile failed", err);
      setScannerStatus("Could not read barcode");
      toast("Could not read barcode from photo. Try again or enter manually.", "error");
    }
  }

  function openManualBarcode() {
    stopScanner();
    $("manual-barcode-input").value = "";
    openModal("modal-barcode-manual");
    setTimeout(() => $("manual-barcode-input").focus(), 300);
  }

  function submitManualBarcode() {
    const code = ($("manual-barcode-input").value || "").trim().replace(/\s/g, "");
    if (!code || code.length < 6) {
      toast("Enter a valid barcode number", "error");
      return;
    }
    closeModal("modal-barcode-manual");
    handleBarcode(code, scanFromFoodModal);
  }

  async function handleBarcode(code, fromFoodModal) {
    code = String(code).trim();
    if (!code) return;

    toast("Looking up " + code + "…");
    try {
      const res = await fetch(
        "https://world.openfoodfacts.org/api/v0/product/" + encodeURIComponent(code) + ".json"
      );
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();

      if (data.status !== 1 || !data.product) {
        toast("Product not found — enter details manually", "error");
        if (fromFoodModal) {
          $("f-barcode").value = code;
          openModal("modal-food");
        } else {
          openNewFood({ barcode: code });
        }
        return;
      }

      const p = data.product;
      const n = p.nutriments || {};

      let cal = n["energy-kcal_serving"] ?? n["energy-kcal_100g"] ?? n["energy-kcal"] ?? 0;
      let fat = n.fat_serving ?? n.fat_100g ?? 0;
      let fiber = n.fiber_serving ?? n.fiber_100g ?? 0;
      let protein = n.proteins_serving ?? n.proteins_100g;
      let carbs = n.carbohydrates_serving ?? n.carbohydrates_100g;
      let sugar = n.sugars_serving ?? n.sugars_100g;
      let sodium = n.sodium_serving ?? n.sodium_100g;
      let saturated = n["saturated-fat_serving"] ?? n["saturated-fat_100g"] ?? n.saturated_fat;
      if (sodium != null && Number(sodium) > 0 && Number(sodium) < 1) {
        sodium = Math.round(Number(sodium) * 1000);
      }

      const serving =
        p.serving_size ||
        (p.serving_quantity
          ? String(p.serving_quantity) + (p.serving_quantity_unit || "g")
          : "1 serving");

      const prefill = {
        name: p.product_name || p.generic_name || "Unknown Product",
        brand: p.brands || "",
        barcode: code,
        servingSize: serving,
        calories: Math.round(Number(cal) || 0),
        fat: Math.round((Number(fat) || 0) * 10) / 10,
        fiber: Math.round((Number(fiber) || 0) * 10) / 10,
        protein: protein != null ? Math.round(Number(protein) * 10) / 10 : undefined,
        carbs: carbs != null ? Math.round(Number(carbs) * 10) / 10 : undefined,
        sugar: sugar != null ? Math.round(Number(sugar) * 10) / 10 : undefined,
        sodium: sodium != null ? Math.round(Number(sodium)) : undefined,
        saturated: saturated != null ? Math.round(Number(saturated) * 10) / 10 : undefined,
        imageUrl: p.image_front_small_url || p.image_url || undefined,
      };

      if (fromFoodModal) {
        fillFoodForm(prefill);
        updateFoodPointsPreview();
        openModal("modal-food");
      } else {
        const existing = state.foods.find((f) => f.barcode === code);
        if (existing) {
          openQtyModal(existing);
        } else {
          openNewFood(prefill);
        }
      }
      toast("Product found!", "success");
    } catch (err) {
      console.error(err);
      toast("Lookup failed — check connection or enter manually", "error");
      if (fromFoodModal) {
        $("f-barcode").value = code;
        openModal("modal-food");
      } else {
        openNewFood({ barcode: code });
      }
    }
  }

  // ─── Escape HTML ─────────────────────────────────────────────
  function esc(s) {
    if (!s) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ─── Tabs ────────────────────────────────────────────────────
  function switchTab(tab) {
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    $("tab-" + tab).classList.add("active");
    document.querySelector(`.tab-btn[data-tab="${tab}"]`).classList.add("active");

    if (tab === "today") renderToday();
    else if (tab === "library") renderLibrary($("library-search").value);
    else if (tab === "daily") renderDaily();
    else if (tab === "settings") renderSettings();
  }

  // ─── Event Bindings ──────────────────────────────────────────
  function bindEvents() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    document.querySelectorAll("[data-close]").forEach((btn) => {
      btn.addEventListener("click", () => closeModal(btn.dataset.close));
    });
    document.querySelectorAll(".modal-overlay").forEach((overlay) => {
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeModal(overlay.id);
      });
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (scannerActive) stopScanner();
        else closeAllModals();
      }
    });

    $("btn-add-today").addEventListener("click", () => openAddModal(getNYDate()));
    $("btn-add-daily").addEventListener("click", () => openAddModal(selectedDate));

    $("btn-new-food").addEventListener("click", () => openNewFood());
    $("library-search").addEventListener("input", (e) => renderLibrary(e.target.value));

    ["f-cal", "f-fat", "f-fiber", "f-manual"].forEach((id) => {
      $(id).addEventListener("input", updateFoodPointsPreview);
    });
    $("btn-save-food").addEventListener("click", saveFood);

    $("add-search").addEventListener("input", (e) => renderAddResults(e.target.value));
    $("btn-create-from-add").addEventListener("click", () => {
      closeModal("modal-add");
      openNewFood();
    });

    $("qty-minus").addEventListener("click", () => {
      let v = Number($("qty-val").value) || 1;
      v = Math.max(0.25, Math.round((v - 0.25) * 100) / 100);
      $("qty-val").value = v;
    });
    $("qty-plus").addEventListener("click", () => {
      let v = Number($("qty-val").value) || 1;
      v = Math.round((v + 0.25) * 100) / 100;
      $("qty-val").value = v;
    });
    $("btn-confirm-qty").addEventListener("click", confirmQty);

    $("btn-scan-food").addEventListener("click", () => {
      closeModal("modal-food");
      startScanner(true);
    });
    $("btn-scan-add").addEventListener("click", () => {
      closeModal("modal-add");
      startScanner(false);
    });
    $("btn-cancel-scan").addEventListener("click", stopScanner);

    $("btn-scan-photo").addEventListener("click", () => openPhotoScan());
    $("scan-file-input").addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) handlePhotoFile(file);
    });
    $("btn-manual-barcode").addEventListener("click", openManualBarcode);
    $("btn-manual-barcode-go").addEventListener("click", submitManualBarcode);
    $("manual-barcode-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitManualBarcode();
    });

    $("set-weight").addEventListener("input", () => {
      updateTargetPreview();
      state.profile.weight = Number($("set-weight").value) || 150;
      recalculateFlexUsed();
      saveState();
      renderToday();
    });
    $("set-activity").addEventListener("change", () => {
      updateTargetPreview();
      state.profile.activity = $("set-activity").value;
      recalculateFlexUsed();
      saveState();
      renderToday();
    });
    $("set-weekstart").addEventListener("change", () => {
      state.profile.weekStartDay = Number($("set-weekstart").value);
      const today = getNYDate();
      state.flexPoints.currentWeekStart = getWeekStart(today, state.profile.weekStartDay);
      recalculateFlexUsed();
      saveState();
      renderToday();
      toast("Week start updated", "success");
    });

    $("btn-reset").addEventListener("click", async () => {
      const ok = await confirmDialog(
        "Reset All Data?",
        "This will permanently delete your food library, all daily history, and settings. This cannot be undone."
      );
      if (ok) {
        const ok2 = await confirmDialog("Are you sure?", "Type-level confirmation: all data will be wiped.");
        if (ok2) {
          localStorage.removeItem(STORAGE_KEY);
          localStorage.removeItem(LEGACY_STORAGE_KEY);
          state = defaultState();
          saveState();
          selectedDate = getNYDate();
          renderToday();
          renderLibrary();
          renderSettings();
          toast("All data reset", "success");
          switchTab("today");
        }
      }
    });

    window.addEventListener("beforeunload", saveState);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") saveState();
    });
  }

  // ─── Init ────────────────────────────────────────────────────
  function init() {
    loadState();
    selectedDate = getNYDate();
    bindEvents();
    renderToday();
    $("today-ring").style.strokeDasharray = CIRCUMFERENCE;
    $("daily-ring").style.strokeDasharray = CIRCUMFERENCE;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
