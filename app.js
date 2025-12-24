document.addEventListener('DOMContentLoaded', () => {
    const app = document.getElementById('app-content');
    const canvas = document.getElementById('box-canvas');
    const ctx = canvas ? canvas.getContext('2d') : null;
    
    if (!app || !canvas || !ctx) return;

    const layoutHost = document.body;
    
    const state = {
        isPlaying: false,
        count: 0, // 0: Inhale, 1: Hold, 2: Exhale, 3: Wait
        countdown: 4,
        totalTime: 0,
        soundEnabled: false,
        timeLimit: '',
        sessionComplete: false,
        timeLimitReached: false,
        phaseTime: 4,
        pulseStartTime: null,
        devicePixelRatio: Math.min(window.devicePixelRatio || 1, 3), // Allow higher ratio for newer iPhones
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        prefersReducedMotion: false,
        hasStarted: false
    };

    let wakeLock = null;
    let audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    // Icons
    const icons = {
        play: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`,
        pause: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`,
        volume2: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`,
        volumeX: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`,
        rotateCcw: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>`,
        clock: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`
    };

    // Refined Palette for OLED Black
    const phaseColors = [
        '#32D74B', // Inhale (iOS Green)
        '#5E5CE6', // Hold (iOS Indigo)
        '#0A84FF', // Exhale (iOS Blue)
        '#BF5AF2'  // Wait (iOS Purple)
    ];

    function getInstruction(count) {
        switch (count) {
            case 0: return 'Inhale';
            case 1: return 'Hold';
            case 2: return 'Exhale';
            case 3: return 'Wait';
            default: return '';
        }
    }

    function hexToRgba(hex, alpha) {
        const normalized = hex.replace('#', '');
        const bigint = parseInt(normalized, 16);
        const r = (bigint >> 16) & 255;
        const g = (bigint >> 8) & 255;
        const b = bigint & 255;
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    function resizeCanvas() {
        const width = window.innerWidth;
        const height = window.innerHeight;
        const pixelRatio = state.devicePixelRatio;

        state.viewportWidth = width;
        state.viewportHeight = height;

        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        canvas.width = Math.floor(width * pixelRatio);
        canvas.height = Math.floor(height * pixelRatio);

        if (ctx) ctx.scale(pixelRatio, pixelRatio);
        
        if (!state.isPlaying) {
            drawScene({ progress: state.sessionComplete ? 1 : 0, phase: state.count });
        }
    }

    window.addEventListener('resize', resizeCanvas, { passive: true });

    function formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    function playTone() {
        if (state.soundEnabled && audioContext) {
            try {
                const t = audioContext.currentTime;
                const oscillator = audioContext.createOscillator();
                const gainNode = audioContext.createGain();
                
                oscillator.type = 'sine';
                oscillator.frequency.setValueAtTime(440, t); // A4
                oscillator.frequency.exponentialRampToValueAtTime(300, t + 0.15); // Soft drop
                
                gainNode.gain.setValueAtTime(0.05, t);
                gainNode.gain.exponentialRampToValueAtTime(0.001, t + 0.1);

                oscillator.connect(gainNode);
                gainNode.connect(audioContext.destination);
                
                oscillator.start(t);
                oscillator.stop(t + 0.15);
            } catch (e) {
                console.error(e);
            }
        }
    }

    let interval;
    let animationFrameId;
    let lastStateUpdate;

    async function requestWakeLock() {
        if ('wakeLock' in navigator) {
            try { wakeLock = await navigator.wakeLock.request('screen'); } catch (err) { console.error(err); }
        }
    }

    function releaseWakeLock() {
        if (wakeLock) { wakeLock.release().then(() => wakeLock = null).catch(console.error); }
    }

    function togglePlay() {
        state.isPlaying = !state.isPlaying;
        if (state.isPlaying) {
            if (audioContext && audioContext.state === 'suspended') audioContext.resume();
            
            if (!state.hasStarted) {
                state.hasStarted = true;
                state.totalTime = 0;
                state.countdown = state.phaseTime;
                state.count = 0;
                state.timeLimitReached = false;
                state.sessionComplete = false;
            }
            
            state.pulseStartTime = performance.now();
            playTone();
            startInterval();
            animate();
            requestWakeLock();
        } else {
            clearInterval(interval);
            cancelAnimationFrame(animationFrameId);
            state.pulseStartTime = null;
            releaseWakeLock();
            drawScene({ progress: (state.phaseTime - state.countdown) / state.phaseTime, phase: state.count, isPaused: true });
        }
        render();
    }

    function resetToStart() {
        state.isPlaying = false;
        state.hasStarted = false;
        state.totalTime = 0;
        state.countdown = state.phaseTime;
        state.count = 0;
        state.sessionComplete = false;
        state.timeLimitReached = false;
        clearInterval(interval);
        cancelAnimationFrame(animationFrameId);
        releaseWakeLock();
        resizeCanvas(); // Clean redraw
        render();
    }

    function toggleSound() {
        state.soundEnabled = !state.soundEnabled;
        render(); // Re-render to update switch UI
    }

    function startWithPreset(minutes) {
        state.timeLimit = minutes.toString();
        resetToStart(); // Ensure fresh state
        togglePlay();
    }

    function startInterval() {
        clearInterval(interval);
        lastStateUpdate = performance.now();
        
        interval = setInterval(() => {
            if (!state.isPlaying) return;

            state.totalTime += 1;
            
            // Check Time Limit
            if (state.timeLimit && !state.timeLimitReached) {
                const limitSecs = parseInt(state.timeLimit) * 60;
                if (state.totalTime >= limitSecs) state.timeLimitReached = true;
            }

            if (state.countdown <= 1) {
                // Phase Change
                state.count = (state.count + 1) % 4;
                state.countdown = state.phaseTime;
                state.pulseStartTime = performance.now();
                playTone();

                // End Session logic
                if (state.count === 3 && state.timeLimitReached) {
                   state.sessionComplete = true;
                   state.isPlaying = false;
                   clearInterval(interval);
                   cancelAnimationFrame(animationFrameId);
                   releaseWakeLock();
                }
            } else {
                state.countdown -= 1;
            }
            
            lastStateUpdate = performance.now();
            render(); 
        }, 1000);
    }

    // Helper for Rounded Rect
    function roundedRect(ctx, x, y, width, height, radius) {
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x + radius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
    }

    function drawScene({ progress = 0, phase = state.count, timestamp = performance.now(), isPaused = false } = {}) {
        if (!ctx) return;

        const width = state.viewportWidth;
        const height = state.viewportHeight;

        // Clear
        ctx.clearRect(0, 0, width, height);

        if (!state.hasStarted && !state.sessionComplete) return;

        // Configuration
        const accentColor = phaseColors[phase];
        const easedProgress = 0.5 - (Math.cos(Math.PI * Math.max(0, Math.min(1, progress))) / 2);
        
        // Dynamic Island & Safe Area aware centering
        // We push the box up slightly to avoid the control deck
        const safeZoneTop = 60; 
        const controlDeckHeight = 220;
        const availableHeight = height - safeZoneTop - controlDeckHeight;
        
        const baseSize = Math.min(width, availableHeight) * 0.55;
        const boxSize = baseSize;
        const top = safeZoneTop + (availableHeight - boxSize) / 2;
        const left = (width - boxSize) / 2;
        const cornerRadius = 32;

        // 1. Draw The Track (The Ghost Box)
        ctx.strokeStyle = hexToRgba(accentColor, 0.15);
        ctx.lineWidth = 4;
        roundedRect(ctx, left, top, boxSize, boxSize, cornerRadius);
        ctx.stroke();

        // 2. Calculate Dot Position
        // Interpolate along the rounded rect path is complex, approximating with straight lines + corners logic
        // Simplified: 4 points logic but smoothed
        const points = [
            { x: left, y: top + boxSize },       // Bottom Left (Start of Inhale)
            { x: left, y: top },                 // Top Left
            { x: left + boxSize, y: top },       // Top Right
            { x: left + boxSize, y: top + boxSize } // Bottom Right
        ];

        const p1 = points[phase];
        const p2 = points[(phase + 1) % 4];
        
        const currentX = p1.x + easedProgress * (p2.x - p1.x);
        const currentY = p1.y + easedProgress * (p2.y - p1.y);

        // 3. Draw Trail
        if (!isPaused && !state.prefersReducedMotion) {
            const trailLength = 20;
            for(let i = 0; i < trailLength; i++) {
                const trailX = currentX - (p2.x - p1.x) * (i/100); 
                const trailY = currentY - (p2.y - p1.y) * (i/100);
                
                ctx.beginPath();
                ctx.arc(trailX, trailY, 15 - (i*0.5), 0, Math.PI * 2);
                ctx.fillStyle = hexToRgba(accentColor, 0.1 - (i * 0.005));
                ctx.fill();
            }
        }

        // 4. Draw The "Breathing" Glow
        // Expand/contract based on inhale (phase 0) vs exhale (phase 2)
        let breathFactor = 0;
        if (phase === 0) breathFactor = easedProgress;
        else if (phase === 1) breathFactor = 1;
        else if (phase === 2) breathFactor = 1 - easedProgress;
        else breathFactor = 0;

        const glowSize = 100 + (breathFactor * 60);
        
        const gradient = ctx.createRadialGradient(currentX, currentY, 0, currentX, currentY, glowSize);
        gradient.addColorStop(0, hexToRgba(accentColor, 0.8));
        gradient.addColorStop(0.2, hexToRgba(accentColor, 0.3));
        gradient.addColorStop(1, 'rgba(0,0,0,0)');
        
        ctx.fillStyle = gradient;
        ctx.globalCompositeOperation = 'screen'; // Additive blending for OLED glow
        ctx.beginPath();
        ctx.arc(currentX, currentY, glowSize, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';

        // 5. Draw The Main Dot
        ctx.beginPath();
        ctx.arc(currentX, currentY, 12, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = accentColor;
        ctx.shadowBlur = 20;
        ctx.fill();
        ctx.shadowBlur = 0;
    }

    function animate() {
        if (!state.isPlaying) return;
        const now = performance.now();
        const elapsed = (now - lastStateUpdate) / 1000;
        const effectiveCountdown = state.countdown - elapsed;
        let progress = (state.phaseTime - effectiveCountdown) / state.phaseTime;
        progress = Math.max(0, Math.min(1, progress));

        drawScene({ progress, timestamp: now });
        animationFrameId = requestAnimationFrame(animate);
    }

    // HTML RENDERER
    function render() {
        // Safe access to state variables
        const isActive = state.isPlaying || state.hasStarted;
        const btnText = state.isPlaying ? 'Pause' : (state.hasStarted ? 'Resume' : 'Start Session');
        const btnIcon = state.isPlaying ? icons.pause : icons.play;
        const phaseLabel = getInstruction(state.count);
        const accent = phaseColors[state.count];

        // 1. Top HUD
        let html = `
            <div class="container">
                <div class="hud-top">
                    <h1>Box Breathing</h1>
                    ${state.hasStarted ? `<div class="timer-badge">${formatTime(state.totalTime)}</div>` : ''}
                </div>
        `;

        // 2. Focus Area (Text)
        if (state.sessionComplete) {
            html += `
                <div class="focus-area">
                    <div class="instruction" style="color: #30d158">Session Complete</div>
                </div>
            `;
        } else if (state.hasStarted) {
            html += `
                <div class="focus-area">
                    <div class="instruction" style="color: ${accent}">${phaseLabel}</div>
                    <div class="countdown">${Math.ceil(state.countdown)}</div>
                    ${state.timeLimitReached ? `<div class="limit-toast">Finishing cycle...</div>` : ''}
                </div>
            `;
        } else {
             // Welcome / Idle State
             html += `
                <div class="focus-area">
                    <div class="instruction" style="opacity: 0.5">Ready</div>
                </div>
             `;
        }

        // 3. Controls Deck
        html += `<div class="controls-deck">`;

        if (!state.sessionComplete) {
            // Phase Tracker (Only show when running)
            if (state.hasStarted) {
                const phases = ['Inhale', 'Hold', 'Exhale', 'Wait'];
                html += `<div class="phase-tracker">`;
                phases.forEach((p, i) => {
                    const isActivePhase = i === state.count;
                    html += `<div class="phase-item ${isActivePhase ? 'active' : ''}">${p}</div>`;
                });
                html += `</div>`;
            }

            // Settings Panel (Hide when playing to reduce distraction, show when paused/idle)
            if (!state.isPlaying) {
                html += `
                <div class="glass-panel">
                    <div class="row-group">
                        <label class="switch-label">
                            <span>Sound</span>
                            <div class="switch">
                                <input type="checkbox" id="sound-toggle" ${state.soundEnabled ? 'checked' : ''}>
                                <span class="slider"></span>
                            </div>
                        </label>
                    </div>

                    <div class="range-container">
                        <div class="range-header">
                            <span>Breath Speed</span>
                            <span id="phase-time-value">${state.phaseTime}s</span>
                        </div>
                        <input type="range" min="3" max="8" step="1" value="${state.phaseTime}" id="phase-time-slider">
                    </div>

                    <div class="row-group">
                        <div class="input-wrap">
                            <input type="number" id="time-limit" placeholder="Limit (min)" value="${state.timeLimit}" inputmode="numeric">
                        </div>
                    </div>

                    <div class="preset-scroll">
                        <button class="chip" data-min="2">2 min</button>
                        <button class="chip" data-min="5">5 min</button>
                        <button class="chip" data-min="10">10 min</button>
                    </div>
                </div>
                `;
            }

            // Main Action Button
            html += `
                <button id="toggle-play" class="btn-large btn-primary ${state.isPlaying ? 'is-playing' : ''}">
                    ${btnIcon}
                    ${btnText}
                </button>
            `;
        } else {
            // Reset Button
            html += `
                <button id="reset" class="btn-large btn-reset">
                    ${icons.rotateCcw} Start Over
                </button>
            `;
        }

        html += `</div></div>`; // Close deck, close container

        app.innerHTML = html;

        // Re-attach listeners
        if (document.getElementById('toggle-play')) {
            document.getElementById('toggle-play').onclick = togglePlay;
        }
        if (document.getElementById('reset')) {
            document.getElementById('reset').onclick = resetToStart;
        }
        
        if (!state.isPlaying && !state.sessionComplete) {
            const soundToggle = document.getElementById('sound-toggle');
            if (soundToggle) soundToggle.onchange = toggleSound;

            const slider = document.getElementById('phase-time-slider');
            if (slider) {
                slider.oninput = (e) => {
                    state.phaseTime = parseInt(e.target.value);
                    document.getElementById('phase-time-value').textContent = state.phaseTime + 's';
                };
            }

            const limitInput = document.getElementById('time-limit');
            if (limitInput) {
                limitInput.oninput = (e) => state.timeLimit = e.target.value;
            }

            const chips = document.querySelectorAll('.chip');
            chips.forEach(btn => {
                btn.onclick = () => startWithPreset(parseInt(btn.dataset.min));
            });
        }
    }

    // Init
    resizeCanvas();
    render();
});