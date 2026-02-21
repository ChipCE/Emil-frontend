// Global settings object (loaded at startup)
let settings = {};
// Client ID for multi-session support
let clientId = sessionStorage.getItem("avatar_client_id");
if (!clientId) {
    // Generate UUID v4
    clientId = crypto.randomUUID();
    sessionStorage.setItem("avatar_client_id", clientId);
}
console.log("Client ID:", clientId);

(async function main() {
    // Load settings first to get model path
    try {
        const settingsRes = await fetch("settings.json", { cache: "no-store" });
        settings = await settingsRes.json();
    } catch (e) {
        console.error("Failed to load settings.json, using defaults:", e);
        settings = {
            model_path: "SDtikuwa/SDtikuwa.model3.json",
            default_zoom: 0.5,
            idle_timeout: 10
        };
    }

    const modelPath = settings.model_path || "SDtikuwa/SDtikuwa.model3.json";

    // Derive CDI path from model path (replace .model3.json with .cdi3.json)
    const cdiPath = modelPath.replace(/\.model3\.json$/, ".cdi3.json");

    // --- Background Setup ---
    const bgContainer = document.getElementById("background-container");
    let hasBackground = false;

    // Try video first, then image
    const bgVideo = settings.background_video || null;
    const bgImage = settings.background_image || null;

    if (bgVideo) {
        try {
            const video = document.createElement("video");
            video.src = bgVideo;
            video.loop = true;
            video.muted = true;
            video.playsInline = true;
            video.autoplay = true;
            video.id = "background-media";

            // Wait for video to be loadable
            await new Promise((resolve, reject) => {
                video.addEventListener("canplay", resolve, { once: true });
                video.addEventListener("error", reject, { once: true });
            });

            bgContainer.appendChild(video);
            video.play().catch(() => { });
            hasBackground = true;
        } catch (e) {
            console.log("Background video failed to load, trying image fallback.");
        }
    }

    if (!hasBackground && bgImage) {
        try {
            const img = document.createElement("img");
            img.src = bgImage;
            img.id = "background-media";

            await new Promise((resolve, reject) => {
                img.addEventListener("load", resolve, { once: true });
                img.addEventListener("error", reject, { once: true });
            });

            bgContainer.appendChild(img);
            hasBackground = true;
        } catch (e) {
            console.log("Background image failed to load, using solid color.");
        }
    }

    const app = new PIXI.Application({
        view: document.getElementById("canvas"),
        autoStart: true,
        resizeTo: window,
        transparent: hasBackground,
        backgroundColor: hasBackground ? undefined : 0x333333,
    });

    const model = await PIXI.live2d.Live2DModel.from(modelPath);

    app.stage.addChild(model);

    // transforms
    model.x = app.screen.width / 2;
    model.y = app.screen.height / 2;
    model.anchor.set(0.5, 0.5);
    // model.scale.set(0.25, 0.25); // Set later in loadConfig

    // Disable automatic mouse tracking
    model.autoInteract = false;

    // interaction
    model.on("hit", (hitAreas) => {
        if (hitAreas.includes("body")) {
            model.motion("tap_body");
        }
    });

    app.stage.interactive = true;
    app.stage.hitArea = app.screen;

    // Parameter UI
    const coreModel = model.internalModel.coreModel;
    const parameterCount = coreModel.getParameterCount();
    const parameterIds = coreModel._parameterIds;

    // Fetch CDI data for parameter names
    let parameterNames = {};
    try {
        const cdiResponse = await fetch(cdiPath, { cache: "no-store" });
        const cdiData = await cdiResponse.json();
        if (cdiData.Parameters) {
            cdiData.Parameters.forEach(p => {
                parameterNames[p.Id] = p.Name;
            });
        }
    } catch (e) {
        console.error("Failed to load CDI data:", e);
    }

    // Derive parameter_wrapper.json path from the model directory
    const modelDir = modelPath.substring(0, modelPath.lastIndexOf("/"));
    const wrapperPath = modelDir + "/parameter_wrapper.json";

    let parameterWrapper = null;
    try {
        const wrapperRes = await fetch(wrapperPath, { cache: "no-store" });
        if (wrapperRes.ok) {
            parameterWrapper = await wrapperRes.json();
        }
    } catch (e) {
        console.log("No parameter_wrapper.json found, using flat parameter list.");
    }

    const container = document.getElementById("controls");
    const sliderElements = {}; // Map parameter ID -> { input, valueDisplay }

    // Helper: create a slider control-group for a given parameter ID
    function createParamSlider(id, displayName) {
        const idx = parameterIds.indexOf(id);
        if (idx === -1) return null; // parameter not found in model

        const min = coreModel.getParameterMinimumValue(idx);
        const max = coreModel.getParameterMaximumValue(idx);
        const def = coreModel.getParameterDefaultValue(idx);

        let current = def;
        try {
            current = coreModel.getParameterValueById(id);
        } catch (e) {
            // ignore
        }

        const div = document.createElement("div");
        div.className = "control-group";

        const label = document.createElement("label");
        label.textContent = displayName || id;

        const valueDisplay = document.createElement("span");
        valueDisplay.textContent = current.toFixed(2);

        const input = document.createElement("input");
        input.type = "range";
        input.min = min;
        input.max = max;
        input.step = 0.01;
        input.value = current;

        input.addEventListener("input", (e) => {
            const val = parseFloat(e.target.value);
            coreModel.setParameterValueById(id, val);
            targetParameters[id] = val;
            valueDisplay.textContent = val.toFixed(2);
        });

        div.appendChild(label);
        div.appendChild(input);
        div.appendChild(valueDisplay);

        sliderElements[id] = { input, valueDisplay };
        return div;
    }

    if (parameterWrapper) {
        // Grouped mode: only show parameters listed in the wrapper, organized by group
        for (const [groupName, params] of Object.entries(parameterWrapper)) {
            const header = document.createElement("h3");
            header.className = "param-group-header";
            header.textContent = groupName;
            container.appendChild(header);

            for (const [paramId, paramInfo] of Object.entries(params)) {
                const slider = createParamSlider(paramId, paramInfo.name);
                if (slider) {
                    container.appendChild(slider);
                }
            }
        }
    } else {
        // Flat mode: show all parameters (original behavior)
        for (let i = 0; i < parameterCount; i++) {
            const id = parameterIds[i];
            const name = parameterNames[id];
            const displayName = name ? `${name} (${id})` : id;
            const slider = createParamSlider(id, displayName);
            if (slider) {
                container.appendChild(slider);
            }
        }
    }

    // Sync slider UI to match targetParameters
    function syncSlidersToTargets() {
        for (const [id, val] of Object.entries(targetParameters)) {
            const el = sliderElements[id];
            if (el) {
                el.input.value = val;
                el.valueDisplay.textContent = parseFloat(val).toFixed(2);
            }
        }
    }

    // --- Export Feature ---
    // Add Export button to the settings panel
    const exportBtn = document.createElement("button");
    exportBtn.id = "export-btn";
    exportBtn.textContent = "Save Parameters";
    container.insertBefore(exportBtn, container.firstChild);

    // Create the export dialog overlay
    const exportOverlay = document.createElement("div");
    exportOverlay.id = "export-overlay";
    exportOverlay.innerHTML = `
        <div id="export-dialog">
            <h3>Save Parameters</h3>
            <div id="export-actions-top">
                <button id="export-select-all">Select All</button>
                <button id="export-deselect-all">Deselect All</button>
            </div>
            <div id="export-checkboxes"></div>
            <textarea id="export-textarea" readonly></textarea>
            <div id="export-actions">
                <button id="export-copy">Copy to Clipboard</button>
            </div>
            <hr style="border: none; border-top: 1px solid #ddd; margin: 8px 0;">
            <div id="save-profile-section">
                <h4>Save As Profile</h4>
                <div class="save-profile-row">
                    <label for="save-profile-target">Target:</label>
                    <select id="save-profile-target">
                        <option value="__new__">(New Profile)</option>
                    </select>
                </div>
                <div class="save-profile-row">
                    <label for="save-profile-name">Name:</label>
                    <input type="text" id="save-profile-name" placeholder="e.g. happy, angry...">
                </div>
                <div class="save-profile-row">
                    <label for="save-profile-scopes">Scopes:</label>
                    <input type="text" id="save-profile-scopes" placeholder="e.g. eyes, mouth, hair">
                </div>
                <div class="save-profile-note">Use commas to separate multiple scopes</div>
                <div class="save-profile-row">
                    <button id="save-profile-btn">Save</button>
                </div>
                <div id="save-profile-status"></div>
            </div>
            <div id="export-actions-bottom">
                <button id="export-close">Close</button>
            </div>
        </div>
    `;
    document.body.appendChild(exportOverlay);

    const exportCheckboxesContainer = document.getElementById("export-checkboxes");
    const exportTextarea = document.getElementById("export-textarea");

    // Save-as-profile elements
    const saveProfileTarget = document.getElementById("save-profile-target");
    const saveProfileName = document.getElementById("save-profile-name");
    const saveProfileScopes = document.getElementById("save-profile-scopes");
    const saveProfileBtn = document.getElementById("save-profile-btn");
    const saveProfileStatus = document.getElementById("save-profile-status");

    // Populate target dropdown with existing profiles
    function populateSaveProfileDropdown() {
        // Keep the first option "(New Profile)"
        while (saveProfileTarget.options.length > 1) {
            saveProfileTarget.remove(1);
        }
        for (const [name, data] of Object.entries(profiles)) {
            if (!data || !data.parameters) continue;
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = name;
            saveProfileTarget.appendChild(opt);
        }
    }

    // Auto-fill name & scopes when a target is selected
    saveProfileTarget.addEventListener("change", () => {
        const val = saveProfileTarget.value;
        if (val === "__new__") {
            saveProfileName.value = "";
            saveProfileScopes.value = "";
            saveProfileName.disabled = false;
        } else {
            saveProfileName.value = val;
            saveProfileName.disabled = true;
            const p = profiles[val];
            if (p && p.scopes) {
                saveProfileScopes.value = p.scopes.join(", ");
            } else {
                saveProfileScopes.value = "";
            }
        }
    });

    // Save handler
    saveProfileBtn.addEventListener("click", async () => {
        let name = saveProfileName.value
            .replace(/[\s\u3000]+/g, ' ')   // normalize all whitespace (incl full-width)
            .trim()
            .replace(/\s+/g, '-')            // replace middle spaces with hyphens
            .replace(/["'`\/\\<>|:*?]/g, '') // strip unsafe chars
            .replace(/-{2,}/g, '-');          // collapse consecutive hyphens
        if (!name) {
            saveProfileStatus.textContent = "⚠ Name required";
            saveProfileStatus.style.color = "#c33";
            return;
        }

        // Collect selected parameters from checkboxes
        const selectedParams = {};
        for (const cb of exportCheckboxes) {
            if (cb.checked) {
                const id = cb.value;
                try {
                    selectedParams[id] = parseFloat(coreModel.getParameterValueById(id).toFixed(2));
                } catch (e) {
                    selectedParams[id] = 0;
                }
            }
        }

        // Split and trim scopes
        const scopesRaw = saveProfileScopes.value;
        const scopes = scopesRaw
            .split(",")
            .map(s => s.trim())
            .filter(s => s.length > 0);

        saveProfileBtn.disabled = true;
        saveProfileStatus.textContent = "Saving...";
        saveProfileStatus.style.color = "#888";

        try {
            const res = await fetch("/api/profiles", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: name,
                    scopes: scopes,
                    parameters: selectedParams
                })
            });
            const data = await res.json();
            if (res.ok) {
                saveProfileStatus.textContent = "✓ Saved!";
                saveProfileStatus.style.color = "#2a6";

                // Reload profiles
                const profilesPath = settings.profiles_path || "profiles.json";
                const profilesRes = await fetch(profilesPath, { cache: "no-store" });
                profiles = await profilesRes.json();

                // Update dropdown and profiles panel
                populateSaveProfileDropdown();
                renderProfileCards();

                setTimeout(() => {
                    saveProfileStatus.textContent = "";
                    exportOverlay.classList.remove("visible");
                    toggleSettingsPanel(false);
                }, 1000);
            } else {
                saveProfileStatus.textContent = "⚠ " + (data.detail || "Error");
                saveProfileStatus.style.color = "#c33";
            }
        } catch (e) {
            saveProfileStatus.textContent = "⚠ Network error";
            saveProfileStatus.style.color = "#c33";
        }
        saveProfileBtn.disabled = false;
    });

    // Build checkboxes for each parameter
    const exportCheckboxes = [];

    function addExportCheckbox(id, displayName) {
        const wrapper = document.createElement("label");
        wrapper.className = "export-checkbox-item";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = id;
        cb.checked = true;
        cb.addEventListener("change", updateExportTextarea);

        const span = document.createElement("span");
        span.textContent = displayName;

        wrapper.appendChild(cb);
        wrapper.appendChild(span);
        exportCheckboxesContainer.appendChild(wrapper);
        exportCheckboxes.push(cb);
    }

    if (parameterWrapper) {
        for (const [, params] of Object.entries(parameterWrapper)) {
            for (const [paramId, paramInfo] of Object.entries(params)) {
                if (parameterIds.includes(paramId)) {
                    addExportCheckbox(paramId, paramInfo.name || paramId);
                }
            }
        }
    } else {
        for (let i = 0; i < parameterCount; i++) {
            const id = parameterIds[i];
            const name = parameterNames[id];
            addExportCheckbox(id, name ? `${name} (${id})` : id);
        }
    }

    function updateExportTextarea() {
        const selected = {};
        for (const cb of exportCheckboxes) {
            if (cb.checked) {
                const id = cb.value;
                try {
                    selected[id] = parseFloat(coreModel.getParameterValueById(id).toFixed(2));
                } catch (e) {
                    selected[id] = 0;
                }
            }
        }
        exportTextarea.value = JSON.stringify(selected, null, 4);
    }

    let editingProfileName = null;

    function resetEditingState() {
        editingProfileName = null;
        exportBtn.textContent = "Save Parameters";
        exportBtn.disabled = false; // Re-enable button
        exportBtn.classList.remove("recording-btn"); // Remove any special styling
        // Remove highlighed state from profiles if any
        document.querySelectorAll(".profile-card").forEach(c => c.classList.remove("editing"));
    }

    exportBtn.addEventListener("click", async () => {
        try {
            if (editingProfileName) {
                // --- Save Mode ---
                await saveEditedProfile();
            } else {
                // --- Export Mode (Original) ---
                updateExportTextarea();
                populateSaveProfileDropdown();
                // Reset save-as fields
                saveProfileTarget.value = "__new__";
                saveProfileName.value = "";
                saveProfileName.disabled = false;
                saveProfileScopes.value = "";
                saveProfileStatus.textContent = "";
                exportOverlay.classList.add("visible");
            }
        } catch (e) {
            console.error("Export button error:", e);
            alert("Error processing save/export: " + e.message);
            exportBtn.disabled = false; // Emergency re-enable
        }
    });

    async function saveEditedProfile() {
        if (!editingProfileName) return;

        const p = profiles[editingProfileName];
        if (!p) return;

        // Collect current parameters
        const currentParams = {};
        // Iterate over all parameters in the model to get current values
        // We use coreModel directly
        for (let i = 0; i < parameterCount; i++) {
            const id = parameterIds[i];
            try {
                currentParams[id] = parseFloat(coreModel.getParameterValueById(id).toFixed(2));
            } catch (e) {
                currentParams[id] = 0;
            }
        }

        // Use a subset if we want to only save what's in the profile, 
        // BUT the user might have added new parameters by moving sliders.
        // For now, let's save ALL parameters that are non-default? 
        // Or just save all visible sliders?
        // Let's stick to the plan: "Save Parameters" usually implies saving the current state.
        // However, we should probably respect the "scopes" if possible, or just save everything.
        // The original "Export" feature uses checkboxes. 
        // Let's grab values from all *active* sliders/parameters.

        // Actually, the original Save Profile feature (in export dialog) saves selected checkboxes.
        // When "Editing", we probably want to update the parameters object of the profile.
        // Let's use the same logic as "Select All" in export for simplicity, 
        // OR better: just save the parameters that are currently defined in the profile 
        // PLUS any that the user might have changed? 
        // Simplest approach: Save ALL parameters. 
        // But maybe we should only save parameters that are already in the profile?
        // IF we only save existing, how do users add new ones?
        // Let's save ALL parameters for now to be safe and comprehensive, 
        // or per the user request "Save the changes to that profile".

        // "Save changes" implies updating the profile with current values.

        exportBtn.textContent = "Saving...";
        exportBtn.disabled = true;

        try {
            const res = await fetch("/api/profiles", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: editingProfileName,
                    scopes: p.scopes || [], // Preserve scopes
                    parameters: currentParams
                })
            });

            if (res.ok) {
                exportBtn.textContent = "Saved!";
                setTimeout(() => {
                    resetEditingState();
                    container.classList.remove("visible"); // Close settings
                    document.body.classList.remove("settings-open");
                    toggleBtn.textContent = "⚙️ Settings";
                }, 1000);

                // Reload profiles
                const profilesPath = settings.profiles_path || "profiles.json";
                const profilesRes = await fetch(profilesPath, { cache: "no-store" });
                profiles = await profilesRes.json();
                renderProfileCards();
            } else {
                exportBtn.textContent = "Error!";
                setTimeout(() => { exportBtn.textContent = `Save to ${editingProfileName}`; exportBtn.disabled = false; }, 2000);
            }
        } catch (e) {
            console.error(e);
            exportBtn.textContent = "Error!";
            setTimeout(() => { exportBtn.textContent = `Save to ${editingProfileName}`; exportBtn.disabled = false; }, 2000);
        }
    }

    document.getElementById("export-close").addEventListener("click", () => {
        exportOverlay.classList.remove("visible");
    });

    exportOverlay.addEventListener("click", (e) => {
        if (e.target === exportOverlay) {
            exportOverlay.classList.remove("visible");
        }
    });

    document.getElementById("export-copy").addEventListener("click", () => {
        navigator.clipboard.writeText(exportTextarea.value).then(() => {
            const btn = document.getElementById("export-copy");
            const original = btn.textContent;
            btn.textContent = "Copied!";
            setTimeout(() => { btn.textContent = original; }, 1500);
        });
    });

    document.getElementById("export-select-all").addEventListener("click", () => {
        exportCheckboxes.forEach(cb => { cb.checked = true; });
        updateExportTextarea();
    });

    document.getElementById("export-deselect-all").addEventListener("click", () => {
        exportCheckboxes.forEach(cb => { cb.checked = false; });
        updateExportTextarea();
    });

    // Toggle Panel
    const toggleBtn = document.getElementById("toggle-btn");
    function toggleSettingsPanel(forceState = null) {
        const isVisible = container.classList.contains("visible");
        const newState = forceState !== null ? forceState : !isVisible;

        if (newState) {
            container.classList.add("visible");
            document.body.classList.add("settings-open");
            toggleBtn.textContent = "⚙️ Close";
        } else {
            container.classList.remove("visible");
            document.body.classList.remove("settings-open");
            toggleBtn.textContent = "⚙️ Settings";
            // If we were editing, cancel it when closing
            if (editingProfileName) {
                resetEditingState();
            }
        }
    }

    toggleBtn.addEventListener("click", () => toggleSettingsPanel());

    // --- Profiles Panel ---
    const profilesBtn = document.getElementById("profiles-btn");

    // Create the profiles slide-out panel
    const profilesPanel = document.createElement("div");
    profilesPanel.id = "profiles-panel";
    profilesPanel.innerHTML = `
        <h3>Profiles</h3>
        <button id="add-profile-btn">+ Add Profile</button>
        <div id="profiles-list"></div>
    `;
    document.body.appendChild(profilesPanel);

    // Wire up Add Profile button
    const addProfileBtn = document.getElementById("add-profile-btn");
    addProfileBtn.addEventListener("click", () => {
        resetEditingState(); // Ensure we're in "New Profile" mode
        toggleSettingsPanel(true); // Open settings
    });

    // --- Scenes Panel ---
    const scenesBtn = document.getElementById("scenes-btn");

    const scenesPanel = document.createElement("div");
    scenesPanel.id = "scenes-panel";
    scenesPanel.innerHTML = `
        <h3>Scenes</h3>
        <button id="add-scene-btn">+ Add Scene</button>
        <div id="scenes-list"></div>
    `;
    document.body.appendChild(scenesPanel);

    const scenesList = document.getElementById("scenes-list");

    const profilesList = document.getElementById("profiles-list");

    // Custom confirm dialog
    function showConfirmDialog(message) {
        return new Promise((resolve) => {
            const overlay = document.createElement("div");
            overlay.className = "confirm-overlay";

            const dialog = document.createElement("div");
            dialog.className = "confirm-dialog";

            const msg = document.createElement("p");
            msg.className = "confirm-message";
            msg.textContent = message;
            dialog.appendChild(msg);

            const actions = document.createElement("div");
            actions.className = "confirm-actions";

            const cancelBtn = document.createElement("button");
            cancelBtn.className = "confirm-cancel";
            cancelBtn.textContent = "Cancel";
            cancelBtn.addEventListener("click", () => {
                overlay.remove();
                resolve(false);
            });

            const confirmBtn = document.createElement("button");
            confirmBtn.className = "confirm-delete";
            confirmBtn.textContent = "Delete";
            confirmBtn.addEventListener("click", () => {
                overlay.remove();
                resolve(true);
            });

            actions.appendChild(cancelBtn);
            actions.appendChild(confirmBtn);
            dialog.appendChild(actions);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            // Focus the cancel button by default
            cancelBtn.focus();
        });
    }

    function renderProfileCards() {
        profilesList.innerHTML = "";
        for (const [name, data] of Object.entries(profiles)) {
            // Skip entries that aren't profile objects (must have "parameters")
            if (!data || !data.parameters) continue;

            const card = document.createElement("div");
            card.className = "profile-card";

            // Info section: name + scope badges
            const info = document.createElement("div");
            info.className = "profile-card-info";

            const nameEl = document.createElement("div");
            nameEl.className = "profile-card-name";
            nameEl.textContent = name;
            info.appendChild(nameEl);

            const scopes = data.scopes;
            if (scopes && scopes.length > 0) {
                const scopesEl = document.createElement("div");
                scopesEl.className = "profile-card-scopes";
                for (const scope of scopes) {
                    const badge = document.createElement("span");
                    badge.className = "scope-badge";
                    badge.textContent = scope;
                    scopesEl.appendChild(badge);
                }
                info.appendChild(scopesEl);
            }

            card.appendChild(info);

            // Apply button
            const applyBtn = document.createElement("button");
            applyBtn.className = "apply-btn";
            applyBtn.textContent = "▶ Apply";
            applyBtn.addEventListener("click", () => {
                stopEverything();
                applyProfile(name);
                syncSlidersToTargets();
                // Reset idle timer
                lastCommandTime = Date.now();
                isIdleState = false;
            });
            card.appendChild(applyBtn);

            // Delete button
            const deleteBtn = document.createElement("button");
            deleteBtn.className = "delete-btn";
            deleteBtn.textContent = "🗑️";
            deleteBtn.title = "Delete profile";
            deleteBtn.addEventListener("click", async () => {
                const confirmed = await showConfirmDialog(`Delete profile "${name}"?`);
                if (!confirmed) return;
                try {
                    const res = await fetch(`/api/profiles?name=${encodeURIComponent(name)}`, {
                        method: "DELETE"
                    });
                    if (res.ok) {
                        const profilesPath = settings.profiles_path || "profiles.json";
                        const profilesRes = await fetch(profilesPath, { cache: "no-store" });
                        profiles = await profilesRes.json();
                        renderProfileCards();
                    }
                } catch (e) {
                    console.error("Failed to delete profile:", e);
                }
            });

            // Edit button
            const editBtn = document.createElement("button");
            editBtn.className = "edit-btn";
            editBtn.textContent = "✏️ Edit";
            editBtn.title = "Edit profile settings";
            editBtn.addEventListener("click", () => {
                startEditingProfile(name);
            });

            const actionContainer = document.createElement("div");
            actionContainer.className = "profile-card-actions";
            actionContainer.appendChild(applyBtn);
            actionContainer.appendChild(editBtn);
            actionContainer.appendChild(deleteBtn);

            card.appendChild(actionContainer);

            profilesList.appendChild(card);
        }
    }

    function startEditingProfile(name) {
        // Reset idle timer
        lastCommandTime = Date.now();
        isIdleState = false;

        editingProfileName = name;
        applyProfile(name);
        syncSlidersToTargets();

        // Highlight the profile card
        document.querySelectorAll(".profile-card").forEach(c => {
            c.classList.toggle("editing", c.querySelector(".profile-card-name").textContent === name);
        });

        // Open settings
        toggleSettingsPanel(true);

        // Update Export button to Save button
        exportBtn.textContent = `Save to "${name}"`;
        exportBtn.classList.add("recording-btn"); // Reuse existing class or add new style
    }

    profilesBtn.addEventListener("click", () => {
        // Close scenes panel if open
        if (scenesPanel.classList.contains("visible")) {
            scenesPanel.classList.remove("visible");
            document.body.classList.remove("scenes-open");
            scenesBtn.textContent = "🎬 Scenes";
        }
        profilesPanel.classList.toggle("visible");
        document.body.classList.toggle("profiles-open", profilesPanel.classList.contains("visible"));
        profilesBtn.textContent = profilesPanel.classList.contains("visible") ? "📋 Close" : "📋 Profiles";
        if (profilesPanel.classList.contains("visible")) {
            renderProfileCards();
        }
    });

    // Play a scene (sequence of profiles with durations)
    // Play a scene (sequence of profiles with durations)
    async function playScene(sceneName, loop = false) {
        const steps = scenes[sceneName];
        if (!steps || !Array.isArray(steps)) return;

        // Increment commandId to interrupt any running sequence
        currentCommandId++;
        const myCommandId = currentCommandId;

        console.log(`Playing scene "${sceneName}"`, loop ? "(looping)" : "(once)");

        // Update state for reporting
        currentSceneName = sceneName;
        isLooping = loop;

        while (true) {
            for (let i = 0; i < steps.length; i++) {
                if (myCommandId !== currentCommandId) {
                    console.log("Scene interrupted");
                    return;
                }

                // Keep idle timer aware of scene activity
                lastCommandTime = Date.now();
                isIdleState = false;

                const step = steps[i];
                if (!profiles[step.profile]) {
                    console.warn(`Skipping deleted profile: ${step.profile}`);
                    continue;
                }
                applyProfile(step.profile);
                syncSlidersToTargets();

                const isLastStep = i === steps.length - 1;
                if (step.duration) {
                    const dur = parseInt(step.duration);
                    // Postpone idle check until after this step finishes
                    lastCommandTime = Date.now() + dur;
                    await new Promise(r => setTimeout(r, dur));
                }
            }

            if (!loop || myCommandId !== currentCommandId) break;
        }

        // Scene finished (if not interrupted/looping forever)
        if (myCommandId === currentCommandId) {
            currentSceneName = null;
            isLooping = false;
        }

        // After scene ends, update timestamp so idle timer starts from now
        lastCommandTime = Date.now();
    }

    // Scene editor dialog
    function openSceneEditor(existingName = null) {
        const isEdit = existingName !== null;
        const existingSteps = isEdit ? (scenes[existingName] || []) : [];

        const overlay = document.createElement("div");
        overlay.className = "scene-editor-overlay";

        const dialog = document.createElement("div");
        dialog.className = "scene-editor-dialog";

        // Header
        const header = document.createElement("h3");
        header.textContent = isEdit ? "Edit Scene" : "Add Scene";
        dialog.appendChild(header);

        // Scene name input
        const nameRow = document.createElement("div");
        nameRow.className = "scene-editor-row";
        const nameLabel = document.createElement("label");
        nameLabel.textContent = "Name:";
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "scene-editor-name";
        nameInput.value = existingName || "";
        nameInput.placeholder = "Scene name";
        if (isEdit) nameInput.disabled = true;
        nameRow.appendChild(nameLabel);
        nameRow.appendChild(nameInput);
        dialog.appendChild(nameRow);

        // Steps container
        const stepsLabel = document.createElement("div");
        stepsLabel.className = "scene-editor-steps-label";
        stepsLabel.textContent = "Profiles:";
        dialog.appendChild(stepsLabel);

        const stepsContainer = document.createElement("div");
        stepsContainer.className = "scene-editor-steps";
        dialog.appendChild(stepsContainer);

        // Available profile names for the dropdown
        const profileNames = Object.keys(profiles);

        function createStepRow(profile = "", duration = 1000) {
            const row = document.createElement("div");
            row.className = "scene-step-row";

            const select = document.createElement("select");
            select.className = "scene-step-profile";

            // If profile exists but is not in profileNames (deleted), add it as a special option
            const isDeleted = profile && !profileNames.includes(profile);
            if (isDeleted) {
                const opt = document.createElement("option");
                opt.value = profile;
                opt.textContent = `⚠️ ${profile} (deleted)`;
                opt.selected = true;
                select.appendChild(opt);
                select.classList.add("deleted-profile-select");
            }

            const emptyOpt = document.createElement("option");
            emptyOpt.value = "";
            emptyOpt.textContent = "-- Select --";
            if (!profile && !isDeleted) emptyOpt.selected = true;
            select.appendChild(emptyOpt);

            for (const pName of profileNames) {
                const opt = document.createElement("option");
                opt.value = pName;
                opt.textContent = pName;
                if (pName === profile && !isDeleted) opt.selected = true;
                select.appendChild(opt);
            }

            // Remove error styling when user selects a valid profile
            select.addEventListener("change", () => {
                select.classList.remove("deleted-profile-select");
            });

            row.appendChild(select);

            const durInput = document.createElement("input");
            durInput.type = "number";
            durInput.className = "scene-step-duration";
            durInput.value = duration;
            durInput.min = 100;
            durInput.step = 100;
            durInput.placeholder = "ms";
            row.appendChild(durInput);

            const msLabel = document.createElement("span");
            msLabel.className = "scene-step-ms";
            msLabel.textContent = "ms";
            row.appendChild(msLabel);

            // Reorder buttons
            const upBtn = document.createElement("button");
            upBtn.className = "scene-step-btn";
            upBtn.textContent = "▲";
            upBtn.title = "Move up";
            upBtn.addEventListener("click", () => {
                const prev = row.previousElementSibling;
                if (prev) stepsContainer.insertBefore(row, prev);
            });
            row.appendChild(upBtn);

            const downBtn = document.createElement("button");
            downBtn.className = "scene-step-btn";
            downBtn.textContent = "▼";
            downBtn.title = "Move down";
            downBtn.addEventListener("click", () => {
                const next = row.nextElementSibling;
                if (next) stepsContainer.insertBefore(next, row);
            });
            row.appendChild(downBtn);

            // Remove button
            const removeBtn = document.createElement("button");
            removeBtn.className = "scene-step-btn scene-step-remove";
            removeBtn.textContent = "✕";
            removeBtn.title = "Remove step";
            removeBtn.addEventListener("click", () => {
                row.remove();
            });
            row.appendChild(removeBtn);

            return row;
        }

        // Populate existing steps
        for (const step of existingSteps) {
            stepsContainer.appendChild(createStepRow(step.profile, step.duration));
        }
        // Start with one empty step for new scenes
        if (!isEdit) {
            stepsContainer.appendChild(createStepRow());
        }

        // Add step button
        const addStepBtn = document.createElement("button");
        addStepBtn.className = "scene-editor-add-step";
        addStepBtn.textContent = "+ Add Profile";
        addStepBtn.addEventListener("click", () => {
            stepsContainer.appendChild(createStepRow());
        });
        dialog.appendChild(addStepBtn);

        // Status message
        const statusMsg = document.createElement("div");
        statusMsg.className = "scene-editor-status";
        dialog.appendChild(statusMsg);

        // Action buttons
        const actions = document.createElement("div");
        actions.className = "scene-editor-actions";

        const cancelBtn = document.createElement("button");
        cancelBtn.className = "scene-editor-cancel";
        cancelBtn.textContent = "Cancel";
        cancelBtn.addEventListener("click", () => overlay.remove());
        actions.appendChild(cancelBtn);

        const saveBtn = document.createElement("button");
        saveBtn.className = "scene-editor-save";
        saveBtn.textContent = "Save";
        saveBtn.addEventListener("click", async () => {
            // Sanitize name
            let name = nameInput.value
                .replace(/[\s\u3000]+/g, ' ')
                .trim()
                .replace(/\s+/g, '-')
                .replace(/["'`\/\\<>|:*?]/g, '')
                .replace(/-{2,}/g, '-');
            if (!name) {
                statusMsg.textContent = "⚠ Name required";
                statusMsg.style.color = "#c33";
                return;
            }

            // Collect steps
            const rows = stepsContainer.querySelectorAll(".scene-step-row");
            const steps = [];
            let hasDurationError = false;

            for (const r of rows) {
                const profileSelect = r.querySelector(".scene-step-profile");
                const profile = profileSelect.value;
                const durationInput = r.querySelector(".scene-step-duration");
                const duration = parseInt(durationInput.value);

                // Reset error styles
                durationInput.classList.remove("scene-step-duration-error");

                if (!profile) {
                    statusMsg.textContent = "⚠ All steps need a profile selected";
                    statusMsg.style.color = "#c33";
                    return;
                }

                if (isNaN(duration) || duration <= 0) {
                    durationInput.classList.add("scene-step-duration-error");
                    hasDurationError = true;
                }

                steps.push({ profile, duration });
            }

            if (steps.length === 0) {
                statusMsg.textContent = "⚠ Add at least one step";
                statusMsg.style.color = "#c33";
                return;
            }

            if (hasDurationError) {
                statusMsg.textContent = "⚠ Duration must be > 0";
                statusMsg.style.color = "#c33";
                return;
            }

            saveBtn.disabled = true;
            statusMsg.textContent = "Saving...";
            statusMsg.style.color = "#888";

            try {
                const res = await fetch("/api/scenes", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name, steps })
                });
                const data = await res.json();
                if (res.ok) {
                    // Reload scenes
                    const scenesPath = settings.scenes_path || "scenes.json";
                    const scenesRes = await fetch(scenesPath, { cache: "no-store" });
                    scenes = await scenesRes.json();
                    renderSceneCards();
                    overlay.remove();
                } else {
                    statusMsg.textContent = "⚠ " + (data.detail || "Error");
                    statusMsg.style.color = "#c33";
                    saveBtn.disabled = false;
                }
            } catch (e) {
                statusMsg.textContent = "⚠ Network error";
                statusMsg.style.color = "#c33";
                saveBtn.disabled = false;
            }
        });
        actions.appendChild(saveBtn);

        dialog.appendChild(actions);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        nameInput.focus();
    }

    // Wire Add Scene button
    document.getElementById("add-scene-btn").addEventListener("click", () => {
        openSceneEditor();
    });

    // Render scene cards
    function renderSceneCards() {
        scenesList.innerHTML = "";
        for (const [name, steps] of Object.entries(scenes)) {
            if (!Array.isArray(steps)) continue;

            const card = document.createElement("div");
            card.className = "scene-card";

            const info = document.createElement("div");
            info.className = "scene-card-info";

            const nameEl = document.createElement("div");
            nameEl.className = "scene-card-name";
            nameEl.textContent = name;
            info.appendChild(nameEl);

            const stepsEl = document.createElement("div");
            stepsEl.className = "scene-card-steps";
            for (const step of steps) {
                const badge = document.createElement("span");
                badge.className = "step-badge";

                if (!profiles[step.profile]) {
                    badge.classList.add("deleted-profile");
                    badge.textContent = `⚠️ ${step.profile} (deleted)`;
                    badge.title = "This profile has been deleted";
                } else {
                    badge.textContent = `${step.profile} (${step.duration}ms)`;
                }
                stepsEl.appendChild(badge);
            }
            info.appendChild(stepsEl);

            // Action buttons row
            const actions = document.createElement("div");
            actions.className = "scene-card-actions";

            const editBtn = document.createElement("button");
            editBtn.className = "scene-edit-btn";
            editBtn.textContent = "✏️ Edit";
            editBtn.addEventListener("click", () => {
                openSceneEditor(name);
            });

            const playBtn = document.createElement("button");
            playBtn.className = "scene-play-btn";
            playBtn.textContent = "▶ Play";
            playBtn.title = "Play scene";
            playBtn.addEventListener("click", () => {
                stopEverything();
                playScene(name, false);
            });
            const loopBtn = document.createElement("button");
            loopBtn.className = "scene-loop-btn";
            loopBtn.textContent = "🔁 Loop";
            loopBtn.title = "Loop scene";
            loopBtn.addEventListener("click", () => {
                stopEverything();
                playScene(name, true);
            });

            actions.appendChild(playBtn);
            actions.appendChild(loopBtn);
            actions.appendChild(editBtn);

            const deleteBtn = document.createElement("button");
            deleteBtn.className = "delete-btn";
            deleteBtn.textContent = "🗑️";
            deleteBtn.title = "Delete scene";
            deleteBtn.addEventListener("click", async () => {
                const confirmed = await showConfirmDialog(`Delete scene "${name}"?`);
                if (!confirmed) return;
                try {
                    const res = await fetch(`/api/scenes?name=${encodeURIComponent(name)}`, {
                        method: "DELETE"
                    });
                    if (res.ok) {
                        const scenesPath = settings.scenes_path || "scenes.json";
                        const scenesRes = await fetch(scenesPath, { cache: "no-store" });
                        scenes = await scenesRes.json();
                        renderSceneCards();
                    }
                } catch (e) {
                    console.error("Failed to delete scene:", e);
                }
            });
            actions.appendChild(deleteBtn);

            info.appendChild(actions);

            card.appendChild(info);
            scenesList.appendChild(card);
        }
    }

    scenesBtn.addEventListener("click", () => {
        // Close profiles panel if open
        if (profilesPanel.classList.contains("visible")) {
            profilesPanel.classList.remove("visible");
            document.body.classList.remove("profiles-open");
            profilesBtn.textContent = "📋 Profiles";
        }
        scenesPanel.classList.toggle("visible");
        document.body.classList.toggle("scenes-open", scenesPanel.classList.contains("visible"));
        scenesBtn.textContent = scenesPanel.classList.contains("visible") ? "🎬 Close" : "🎬 Scenes";
        if (scenesPanel.classList.contains("visible")) {
            renderSceneCards();
        }
    });

    // Sync Toggle Logic
    let isSyncEnabled = true;
    const syncBtn = document.getElementById("sync-btn");

    function updateSyncUI() {
        if (syncBtn) {
            syncBtn.textContent = isSyncEnabled ? "⚡ Sync: ON" : "⚡ Sync: OFF";
            syncBtn.classList.toggle("active", isSyncEnabled);
        }
    }

    // Initialize sync state from backend
    try {
        const syncRes = await fetch("/api/status");
        const syncData = await syncRes.json();
        // Backend now returns { clients: { id: { ... } } }
        if (syncData.clients && syncData.clients[clientId]) {
            isSyncEnabled = syncData.clients[clientId].model_state.is_sync_enabled;
        } else {
            // Default if session new
            isSyncEnabled = true;
        }
        updateSyncUI();
    } catch (e) {
        console.error("Failed to fetch sync state:", e);
    }

    if (syncBtn) {
        syncBtn.addEventListener("click", async () => {
            isSyncEnabled = !isSyncEnabled;
            updateSyncUI();
            try {
                await fetch("/api/status", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        client_id: clientId,
                        is_sync_enabled: isSyncEnabled
                    })
                });
            } catch (e) {
                console.error("Failed to sync state:", e);
            }
            console.log("Sync with Backend:", isSyncEnabled);
        });
    }

    // Mute Toggle Logic
    let isMuted = false;
    let currentAudioElement = null; // Store HTMLAudioElement to pause/stop
    const muteBtn = document.getElementById("mute-btn");

    function updateMuteUI() {
        if (muteBtn) {
            muteBtn.textContent = isMuted ? "🔇 Muted" : "🔊 Audio";
            muteBtn.classList.toggle("active", !isMuted);
        }
        // Apply to currently playing audio
        if (currentAudioElement) {
            currentAudioElement.muted = isMuted;
        }
    }

    // Initialize mute state from backend
    try {
        const statusRes = await fetch("/api/status");
        const statusData = await statusRes.json();
        if (statusData.clients && statusData.clients[clientId]) {
            isMuted = statusData.clients[clientId].model_state.is_muted;
        } else {
            isMuted = false;
        }
        updateMuteUI();
    } catch (e) {
        console.error("Failed to fetch mute state:", e);
    }

    if (muteBtn) {
        muteBtn.addEventListener("click", async () => {
            isMuted = !isMuted;
            updateMuteUI();
            try {
                await fetch("/api/status", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        client_id: clientId,
                        is_muted: isMuted
                    })
                });
            } catch (e) {
                console.error("Failed to sync mute state:", e);
            }
            console.log("Muted:", isMuted);
        });
    }

    // --- Audio & Overlay Init ---
    const overlay = document.getElementById("start-overlay");
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();

    overlay.addEventListener("click", async () => {
        await audioContext.resume();
        overlay.style.display = "none";
        console.log("AudioContext resumed and overlay hidden");
    });

    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    // --- Subtitles ---
    const subtitleContainer = document.getElementById("subtitle-container");
    let subtitleTimeout = null;

    function showSubtitle(text, durationMs = 5000) {
        if (!text) return;

        subtitleContainer.textContent = text;
        subtitleContainer.classList.add("visible");

        if (subtitleTimeout) clearTimeout(subtitleTimeout);

        // If durationMs is provided, set a timeout to hide it.
        // If null, it will be hidden by other events (like audio ending).
        if (durationMs) {
            subtitleTimeout = setTimeout(() => {
                subtitleContainer.classList.remove("visible");
            }, durationMs);
        }
    }

    function hideSubtitle() {
        subtitleContainer.classList.remove("visible");
        if (subtitleTimeout) {
            clearTimeout(subtitleTimeout);
            subtitleTimeout = null;
        }
    }

    // --- Polling & State Management ---
    let profiles = {};
    let scenes = {};
    let isTalking = false;
    // currentAudioElement is declared above, near updateMuteUI
    let targetParameters = {}; // Store target values for transitions

    // Load Configuration Files
    async function loadConfig() {
        try {
            const profilesPath = settings.profiles_path || "profiles.json";
            const profilesRes = await fetch(profilesPath, { cache: "no-store" });
            profiles = await profilesRes.json();

            // Load scenes
            const scenesPath = settings.scenes_path || "scenes.json";
            try {
                const scenesRes = await fetch(scenesPath, { cache: "no-store" });
                scenes = await scenesRes.json();
                console.log("Scenes loaded:", scenes);
            } catch (e) {
                console.warn("No scenes.json found, skipping.");
                scenes = {};
            }

            console.log("Profiles loaded:", profiles);
            console.log("Settings loaded:", settings);

            if (settings.default_zoom !== undefined) {
                model.scale.set(settings.default_zoom, settings.default_zoom);
            } else {
                model.scale.set(0.25, 0.25);
            }

            // Apply default profile if it exists
            if (profiles.default) {
                applyProfile("default");
                currentProfileName = "default"; // Ensure tracking is set
                syncSlidersToTargets();
            }
        } catch (e) {
            console.error("Failed to load configuration:", e);
        }
    }

    loadConfig();

    let currentCommandId = 0;
    let lastCommandTime = Date.now();
    let isIdleState = false;

    // Status tracking
    let currentProfileName = null;
    let currentSceneName = null;
    let isLooping = false;

    // Queue for sequential playback
    let frontendCommandQueue = [];
    let isProcessingCommand = false;

    // Helper to stop any running scene or audio
    function stopEverything() {
        currentCommandId++; // Invalidate running loops
        if (currentAudioElement) {
            currentAudioElement.pause();
            currentAudioElement = null;
        }
        isTalking = false;
        hideSubtitle();
        isProcessingCommand = false; // Reset processing flag
        currentSceneName = null; // Reset scene
        isLooping = false; // Reset looping status
    }

    // New entry point for commands from polling
    function processIncomingCommand(command) {
        // Default to interrupt=false if not specified (backend usually sends true for PlayScene unless specified)
        // Acts as a gatekeeper. 
        const interrupt = command.interrupt || false;

        if (interrupt) {
            console.log("Interrupting for new command:", command);
            stopEverything();
            frontendCommandQueue = []; // Clear queue
            // Execute immediately
            executeCommand(command);
        } else {
            console.log("Queueing command:", command);
            frontendCommandQueue.push(command);
            tryProcessNextCommand();
        }
    }

    function tryProcessNextCommand() {
        if (isProcessingCommand) return;
        if (frontendCommandQueue.length === 0) return;

        const nextCmd = frontendCommandQueue.shift();
        executeCommand(nextCmd);
    }

    // Polling Loop
    setInterval(async () => {
        // Only poll if overlay is hidden
        if (overlay && overlay.style.display === "none") {
            try {
                const res = await fetch(`/api/queue?client_id=${clientId}`);
                if (res.status === 200) {
                    const command = await res.json();
                    if (command) {
                        console.log("Received command:", command);
                        processIncomingCommand(command);
                    }
                }
            } catch (e) {
                // console.error("Polling error:", e);
            }
        }
    }, settings.queue_poll_interval ?? 200);

    // Command Handler
    // Command Handler - now internal execution
    async function executeCommand(command) {
        isProcessingCommand = true;
        const commandId = ++currentCommandId;
        lastCommandTime = Date.now();
        isIdleState = false;

        // Process command if payload exists, ignoring specific types
        if (command.payload) {
            const { audio_url, profile, profiles: profileSequence, msg, loop } = command.payload;
            const interrupt = command.interrupt || false;

            // 0. Handle Interrupt
            if (interrupt) {
                if (currentAudioElement) {
                    currentAudioElement.pause();
                    currentAudioElement = null;
                }
                isTalking = false;
                hideSubtitle();
                // Note: incrementing currentCommandId above effectively halts any existing sequence loops
            }

            // 1. Show/Hide Subtitle
            if (msg) {
                showSubtitle(msg, audio_url ? null : 5000);
            } else {
                hideSubtitle();
            }

            // 2. Play Audio (Optional)
            if (audio_url && typeof audio_url === "string" && audio_url.trim() !== "") {
                let url = audio_url;
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    url = `/api/proxy?url=${encodeURIComponent(url)}`;
                }
                playAudio(url);
            }

            // 3. Set Target Parameters (Profile or Sequence)
            // Resolve scene if provided
            let sequenceToPlay = profileSequence;
            let shouldLoop = loop;

            if (command.payload.scene) {
                const sceneName = command.payload.scene;
                if (scenes[sceneName]) {
                    currentSceneName = sceneName; // Track current scene
                    sequenceToPlay = scenes[sceneName];
                    console.log(`Resolved scene '${sceneName}' to sequence:`, sequenceToPlay);
                } else {
                    console.warn(`Scene '${sceneName}' not found`);
                }
            }

            if (sequenceToPlay && Array.isArray(sequenceToPlay)) {
                console.log("Playing profile sequence:", sequenceToPlay, "Looping:", !!shouldLoop);

                if (shouldLoop) {
                    isLooping = true;
                }

                // Infinite loop if loopProfile is true, otherwise run once
                while (true) {
                    for (let i = 0; i < sequenceToPlay.length; i++) {
                        // Check if we've been interrupted by a newer command
                        // Check if we've been interrupted by a newer command
                        if (commandId !== currentCommandId) {
                            console.log("Sequence interrupted by new command");
                            isProcessingCommand = false; // Interrupted means finished/stopped
                            return; // Stop the entire command handler
                        }

                        // Refresh idle timer if we are looping
                        if (shouldLoop) {
                            lastCommandTime = Date.now();
                            isIdleState = false;
                        }

                        const step = sequenceToPlay[i];
                        // Support both string (profile name), object with .name (old format), or object with .profile (scenes.json format)
                        let name = typeof step === "string" ? step : (step.profile || step.name);
                        const duration = typeof step === "string" ? null : step.duration;

                        if (name) {
                            applyProfile(name);
                        }

                        // Wait for the specified duration (only skip if it's the last one AND we aren't looping)
                        const isLastStep = i === sequenceToPlay.length - 1;
                        if (duration) {
                            const dur = parseInt(duration);
                            // Postpone idle check until after this step finishes
                            lastCommandTime = Date.now() + dur;
                            await new Promise(resolve => setTimeout(resolve, dur));
                        }
                    }

                    if (!shouldLoop || commandId !== currentCommandId) break;
                }
            } else if (profile) {
                applyProfile(profile);
            }
        }

        // Command finished
        isProcessingCommand = false;
        isLooping = false;
        currentSceneName = null;
        tryProcessNextCommand();
    }

    function applyProfile(profileName) {
        if (!isSyncEnabled) return;
        if (!profiles[profileName]) {
            console.warn(`Profile not found: ${profileName}`);
            return;
        }

        currentProfileName = profileName; // Track current profile
        const p = profiles[profileName];

        // Reset logic using "default" profile as base
        if (profiles.default && profiles.default.parameters) {
            targetParameters = { ...profiles.default.parameters };
        }

        if (p.parameters) {
            Object.assign(targetParameters, p.parameters);
        }

        // Fallback for motions 
        if (p.group !== undefined) {
            model.motion(p.group, p.index, p.priority || 3);
        }

        // Status reporting
        reportState(profileName);
    }

    // Audio Playback & Lip Sync
    function playAudio(url) {
        // Stop any current audio
        if (currentAudioElement) {
            currentAudioElement.pause();
            currentAudioElement = null;
        }

        isTalking = true;

        const audio = new Audio(url);
        currentAudioElement = audio; // Store for interruption

        // CORS policy might block this if not same origin, but we serve from same backend
        audio.crossOrigin = "anonymous";

        const source = audioContext.createMediaElementSource(audio);
        source.connect(analyser);
        analyser.connect(audioContext.destination);

        audio.play().catch(e => console.error("Audio play failed:", e));
        audio.muted = isMuted;

        audio.onended = () => {
            isTalking = false;
            currentAudioElement = null;
            // Hide subtitle when audio ends
            hideSubtitle();
            // Return to default parameters when done talking
            if (isSyncEnabled && profiles.default && profiles.default.parameters) {
                targetParameters = { ...profiles.default.parameters };
            }
            reportState(null); // Report idle
        };
    }

    // Update Loop (Ticker)
    app.ticker.add((delta) => {
        // 1. Smoothly transition parameters (Lerp)
        // Transition loop always runs to ensure manual values are "sticky"
        const lerpFactor = 0.1 * delta;
        for (const [id, targetValue] of Object.entries(targetParameters)) {
            try {
                const currentValue = coreModel.getParameterValueById(id);
                const newValue = currentValue + (targetValue - currentValue) * lerpFactor;
                coreModel.setParameterValueById(id, newValue);
            } catch (e) { }
        }

        // 2. Lip Sync
        if (isTalking) {
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < bufferLength; i++) {
                sum += dataArray[i];
            }
            let average = sum / bufferLength;

            // Map average volume (0-255) to mouth open (0.0-1.0)
            const volume = Math.min(1, average / 50); // Sensitivity factor

            // Set parameter
            try {
                coreModel.setParameterValueById("ParamMouthOpenY", volume);
            } catch (e) { }
        }
        // 3. Idle Timeout Check
        if (isSyncEnabled) {
            let timeoutSeconds = settings.idle_timeout;
            if (typeof timeoutSeconds !== "number" || timeoutSeconds <= 0) {
                timeoutSeconds = 10;
            }
            const idleTimeout = timeoutSeconds * 1000;

            if (!isIdleState && !isTalking && Date.now() - lastCommandTime > idleTimeout) {
                console.log("Idle timeout reached, reverting to idle profile");

                // Try 'idle' profile, fallback to 'default'
                if (profiles.idle) {
                    applyProfile("idle");
                    isIdleState = true;
                } else if (profiles.default) {
                    console.log("Idle profile not found, using default");
                    applyProfile("default");
                    isIdleState = true;
                } else {
                    console.warn("No idle or default profile found for timeout");
                    // Prevent repetitive warnings by setting true anyway
                    isIdleState = true;
                }
            }
        }
    });

    // State Reporting
    async function reportState(currentMotion) {
        // console.log("Reporting state:", { currentProfileName, currentSceneName, isLooping });
        try {
            await fetch("/api/report", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    client_id: clientId,
                    current_profile: currentProfileName,
                    current_scene: currentSceneName,
                    queue_size: frontendCommandQueue.length,
                    is_looping: isLooping
                })
            });
        } catch (e) {
            console.error("Report failed:", e);
        }
    }

    // --- Extras Status Feature ---
    function getValueFromPath(obj, path) {
        if (!path || !obj) throw new Error("Invalid path or object");
        // Handle paths like "sub.subVal" or "[0].id"
        // Replace array indexing [0] with .0 for easier splitting
        const normalizedPath = path.replace(/\[(\w+)\]/g, '.$1').replace(/^\./, '');
        const keys = normalizedPath.split('.');
        let current = obj;
        for (const key of keys) {
            if (current === undefined || current === null || !(key in current)) {
                throw new Error(`Key ${key} not found in path ${path}`);
            }
            current = current[key];
        }

        if (typeof current === 'object' && current !== null) {
            throw new Error(`Path ${path} resolves to an object, not a primitive value`);
        }

        return current;
    }

    if (settings.extras && Array.isArray(settings.extras) && settings.extras.length > 0) {
        const extrasContainer = document.createElement('div');
        extrasContainer.id = 'extras-container';
        document.body.appendChild(extrasContainer);

        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'extras-toggle-btn';
        toggleBtn.textContent = 'Hide Extras';
        extrasContainer.appendChild(toggleBtn);

        let isExtrasHidden = false;
        toggleBtn.addEventListener('click', () => {
            isExtrasHidden = !isExtrasHidden;
            if (isExtrasHidden) {
                extrasContainer.classList.add('hidden');
                toggleBtn.textContent = 'Show Extras';
            } else {
                extrasContainer.classList.remove('hidden');
                toggleBtn.textContent = 'Hide Extras';
            }
        });

        settings.extras.forEach((config, index) => {
            const groupDiv = document.createElement('div');
            groupDiv.className = 'extras-group';
            groupDiv.id = `extras-group-${index}`;

            const groupName = document.createElement('div');
            groupName.className = 'extras-group-name';
            groupName.textContent = config.endpointName || 'Unknown';
            groupDiv.appendChild(groupName);

            const valueContainers = [];

            if (config.data && Array.isArray(config.data)) {
                config.data.forEach((dataDef) => {
                    const rowDiv = document.createElement('div');
                    rowDiv.className = 'extras-row';

                    const label = document.createElement('span');
                    label.className = 'extras-label';
                    label.textContent = dataDef.name;

                    const value = document.createElement('span');
                    value.className = 'extras-value';
                    value.textContent = '-';

                    rowDiv.appendChild(label);
                    rowDiv.appendChild(value);
                    groupDiv.appendChild(rowDiv);

                    valueContainers.push({
                        def: dataDef,
                        valElement: value,
                        rowElement: rowDiv
                    });
                });
            }

            extrasContainer.appendChild(groupDiv);
            extrasContainer.style.display = 'block';

            async function fetchData() {
                try {
                    let fetchUrl = config.endpoint;
                    if (config.proxy) {
                        fetchUrl = `/api/extrasProxy?url=${encodeURIComponent(config.endpoint)}`;
                    }

                    const res = await fetch(fetchUrl);
                    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
                    const json = await res.json();

                    if (config.proxy && json._status && json._status !== 200) {
                        throw new Error(`Proxy error ${json._status}`);
                    }

                    groupDiv.style.display = 'block';
                    valueContainers.forEach(vc => {
                        try {
                            const val = getValueFromPath(json, vc.def.key);
                            vc.rowElement.style.display = 'flex';
                            vc.valElement.textContent = val !== undefined ? val : '-';
                        } catch (keyErr) {
                            console.warn(`Extras key error for ${vc.def.key}:`, keyErr.message);
                            if (config.hideOnErr) {
                                vc.rowElement.style.display = 'none';
                            } else {
                                vc.rowElement.style.display = 'flex';
                                vc.valElement.textContent = '-';
                            }
                        }
                    });
                } catch (err) {
                    console.error('Extras fetch error for', config.endpointName, err);
                    groupDiv.style.display = 'block';
                    if (config.hideOnErr) {
                        valueContainers.forEach(vc => {
                            vc.rowElement.style.display = 'none';
                        });
                    } else {
                        valueContainers.forEach(vc => {
                            vc.rowElement.style.display = 'flex';
                            vc.valElement.textContent = '-';
                        });
                    }
                }
            }

            fetchData();
            if (config.refreshTime && config.refreshTime > 0) {
                setInterval(fetchData, config.refreshTime);
            }
        });
    }

    // Export model to window for debugging
    window.model = model;
})();
