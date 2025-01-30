import {el} from '@elemaudio/core';
import WebRenderer from '@elemaudio/web-renderer';

// Add new Sequence class before TestComponent
class Sequence {
    constructor() {
        this.elements = [];
        this.bpm = 120;
        this.bars = "1 bar";
        this.isRecording = false;
        this.volume = 1;
        this.isMuted = false;
        this.isSolo = false;
        this.startOffset = 0; // Add start offset property (0 to 1)
    }

    addElement(soundUrl) {
        this.elements.push({
            soundUrl,
            offset: 1,
            shift: 0,
            stretch: 1,
            duration: 1
        });
    }

    clear() {
        this.elements = [];
    }

    setShift(index, shift) {
        if (index >= 0 && index < this.elements.length) {
            this.elements[index].shift = shift;
        }
    }

    setStretch(index, stretch) {
        if (index >= 0 && index < this.elements.length) {
            this.elements[index].stretch = stretch;
        }
    }

    setOffset(index, offset) {
        if (index >= 0 && index < this.elements.length) {
            this.elements[index].offset = offset;
        }
    }

    setDuration(index, duration) {
        if (index >= 0 && index < this.elements.length) {
            this.elements[index].duration = duration;
        }
    }

    getDurationInSeconds() {
        const beatsPerBar = 4;
        const barMultiplier = {
            "1/4 bar": 0.25,
            "1/2 bar": 0.5,
            "1 bar": 1,
            "2 bars": 2,
            "3 bars": 3,
            "4 bars": 4,
            "8 bars": 8
        }[this.bars] || 1;

        return (60 / this.bpm) * beatsPerBar * barMultiplier;
    }

    getElementTimes() {
        if (this.elements.length === 0) return [];

        const positions = [];
        let totalOffset = 0;
        
        this.elements.forEach(el => totalOffset += el.offset);
        
        let currentTime = 0;
        this.elements.forEach(el => {
            const relativeTime = currentTime / totalOffset;
            positions.push(relativeTime);
            currentTime += el.offset;
        });

        return positions;
    }

    removeElement(index) {
        if (index >= 0 && index < this.elements.length) {
            this.elements.splice(index, 1);
        }
    }
}

class TestComponent extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this.core = new WebRenderer();
        this.ctx = new AudioContext();
        this.initialized = false;
        this.uploadedSamples = new Set();
        this.sampleDurations = new Map();
        this.loopingVoices = new Map(); // Track which sounds are currently looping
        this.activeVoices = new Map(); // Track active one-off voices
        this.maxVoices = 4; // Maximum concurrent one-off voices
        this.mode = 'explore one-off';
        this.interactionMode = 'hover';
        
        // Trajectory recording state
        this.isRecording = false;
        this.recordingStartTime = null;
        this.trajectoryEvents = [];
        this.isPlayingTrajectory = false; // New interaction mode setting

        this.voiceTimeouts = new Map(); // Track timeouts for cleanup

        // Replace single trajectory state with multiple trajectories
        this.trajectories = new Map(); // Map of trajectory ID to trajectory data
        this.activeTrajectorySignals = new Map(); // Map of trajectory ID to active elementary signal
        this.currentRecordingId = null;

        // Replace single sequence with multiple sequences
        this.sequences = new Map();
        this.sequenceSignals = new Map();
        this.globalBpm = 120;
        
        // Remove single sequence state
        // this.sequence = new Sequence();
        // this.sequenceSignal = null;

        // Add sample playback parameters
        this.sampleParams = {
            startOffset: 0,
            endOffset: 0,
            playbackRate: 1
        };

        this.activeSequenceId = null; // Add tracking for active sequence
        this.soloSequences = new Set(); // Track which sequences are soloed
    }

    async initializeAudio() {
        try {
            if (this.ctx.state === 'suspended') {
                await this.ctx.resume();
            }
            
            if (!this.initialized) {
                const node = await this.core.initialize(this.ctx, {
                    numberOfInputs: 0,
                    numberOfOutputs: 1,
                    outputChannelCount: [2], // Stereo output
                });
                node.connect(this.ctx.destination);
                this.initialized = true;
            }
            
            return true;
        } catch (error) {
            console.error('Failed to initialize audio:', error);
            return false;
        }
    }

    createOneOffVoice(soundUrl) {
        const voiceKey = `voice-${Date.now()}`;
        return el.mul(
            el.mc.sample(
                {
                    channels: 1,
                    path: soundUrl, 
                    mode: 'trigger',
                    playbackRate: this.sampleParams.playbackRate,
                    startOffset: this.sampleParams.startOffset,
                    endOffset: this.sampleParams.endOffset
                },
                el.const({ key: `${voiceKey}-trigger`, value: 1 }),
                1
            )[0],
            el.const({ value: 1 / this.maxVoices }) // Dynamic gain scaling
        );
    }

    createLoopingVoice(soundUrl, duration) {
        // Create a time signal that loops based on the sample duration
        const time = el.mod(
            el.div(el.time(), el.sr()),
            duration
        );

        // Create a looping sequence with the sample, now using sample parameters
        return el.mul(
            el.mc.sample({
                channels: 1,
                path: soundUrl,
                mode: 'loop',
                playbackRate: this.sampleParams.playbackRate,
                startOffset: this.sampleParams.startOffset,
                endOffset: this.sampleParams.endOffset
            }, el.const({ value: 1 }), el.const({ value: 1 }))[0],
            el.const({ value: 1 / this.maxVoices })
        );
    }

    createSequenceVoices(sequence) {
        if (sequence.elements.length === 0) return null;

        // Check if sequence should be silent due to mute/solo status
        const anySolo = this.soloSequences.size > 0;
        const isSilent = sequence.isMuted || (anySolo && !sequence.isSolo);
        if (isSilent) return el.const({value: 0});

        const sequenceDuration = sequence.getDurationInSeconds();
        const times = sequence.getElementTimes();
        try {
            // Create array of sample sequencers
            const voices = sequence.elements.map((element, index) => {
                if (!this.uploadedSamples.has(element.soundUrl)) {
                    console.warn('Sample not loaded:', element.soundUrl);
                    return null;
                }

                const sampleDuration = this.sampleDurations.get(element.soundUrl);
                // Add sequence start offset to the timing calculation
                const startTime = sequence.startOffset * sequenceDuration + 
                                times[index] * (1 - sequence.startOffset) * sequenceDuration;
                const endTime = Math.max(startTime + sampleDuration, sequenceDuration);

                const time = el.mod(
                  el.div(el.time(), el.sr()),
                  sequenceDuration
                );

                try {
                  return el.sampleseq2({
                      path: element.soundUrl,
                      duration: sampleDuration * element.duration,
                      seq: [
                          { time: startTime, value: 1 },
                          { time: endTime, value: 0 }
                      ],
                      shift: element.shift,
                      stretch: element.stretch
                    }, 
                    // el.div(el.time(), el.sr())
                    time
                  );
                } catch (error) {
                    console.error('Failed to create sample sequencer:', error);
                    return null;
                }
            }).filter(voice => voice !== null);

            if (voices.length === 0) return null;

            // Sum all voices and apply gain
            return voices.length === 1 ? 
                el.mul(voices[0], el.const({value: sequence.volume / this.maxVoices})) :
                el.mul(el.add(...voices), el.const({value: sequence.volume / this.maxVoices}));
        } catch (error) {
            console.error('Error in createSequenceVoices:', error);
            return null;
        }
    }

    updateSequencePlayback(sequenceId) {
        try {
            const sequence = this.sequences.get(sequenceId);
            if (!sequence) return;

            const signal = this.createSequenceVoices(sequence);
            if (signal) {
                this.sequenceSignals.set(sequenceId, signal);
            } else {
                this.sequenceSignals.delete(sequenceId);
            }
            this.updateAudioGraph();
        } catch (error) {
            console.error('Error in updateSequencePlayback:', error);
            this.sequenceSignals.delete(sequenceId);
            this.updateAudioGraph();
        }
    }

    updateAudioGraph() {
        let signal;

        if (this.mode === 'explore looping') {
            // For looping mode, sum all active looping voices
            if (this.loopingVoices.size > 0) {
                const voices = Array.from(this.loopingVoices.values());
                signal = el.add(...voices);
            } else {
                signal = el.const({value: 0}); // Silence
            }
        } else if (this.mode === 'explore one-off') {
            // For one-off mode, sum all active voices
            if (this.activeVoices.size > 0) {
                const voices = Array.from(this.activeVoices.values());
                signal = voices.length === 1 ? voices[0] : el.add(...voices);
            } else {
                signal = el.const({value: 0}); // Silence
            }
        }

        // Add all sequence signals if active
        if (this.sequenceSignals.size > 0) {
            const seqSignals = Array.from(this.sequenceSignals.values());
            const seqMix = seqSignals.length === 1 ? 
                seqSignals[0] : el.add(...seqSignals);
            signal = signal ? el.add(signal, seqMix) : seqMix;
        }

        // Add trajectory signals
        if (this.activeTrajectorySignals.size > 0) {
            const trajectorySignals = Array.from(this.activeTrajectorySignals.values());
            const trajectoryMix = trajectorySignals.length === 1 ? 
                trajectorySignals[0] : el.add(...trajectorySignals);
            
            signal = signal ? el.add(signal, trajectoryMix) : trajectoryMix;
        }

        if (!signal) {
            signal = el.const({value: 0});
        }

        // Render the same signal to both channels for proper stereo
        this.core.render(signal, signal);
    }

    async toggleLoopingSound(element) {
        if (!this.initialized) return;

        const soundUrl = element.getAttribute('data-sound');
        const isLooping = this.loopingVoices.has(soundUrl);

        if (isLooping) {
            // Stop looping
            this.loopingVoices.delete(soundUrl);
            element.classList.remove('looping');
        } else {
            // Start looping
            if (!this.uploadedSamples.has(soundUrl)) {
                const res = await fetch(soundUrl);
                const sampleBuffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
                
                await this.core.updateVirtualFileSystem({
                    [soundUrl]: [sampleBuffer.getChannelData(0)]
                });
                
                this.uploadedSamples.add(soundUrl);
                this.sampleDurations.set(soundUrl, sampleBuffer.duration);
            }

            const duration = this.sampleDurations.get(soundUrl);
            const loopingVoice = this.createLoopingVoice(soundUrl, duration);
            this.loopingVoices.set(soundUrl, loopingVoice);
            element.classList.add('looping');
        }

        this.updateAudioGraph();
    }

    async playOneOffSound(element) {
        if (!this.initialized) return;

        const soundUrl = element.getAttribute('data-sound');
        
        if (!this.uploadedSamples.has(soundUrl)) {
            const res = await fetch(soundUrl);
            const sampleBuffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
            
            await this.core.updateVirtualFileSystem({
                [soundUrl]: [sampleBuffer.getChannelData(0)]
            });
            
            this.uploadedSamples.add(soundUrl);
            this.sampleDurations.set(soundUrl, sampleBuffer.duration);
        }

        const duration = this.sampleDurations.get(soundUrl);

        // Manage voice collection - remove oldest voice if at max
        if (this.activeVoices.size >= this.maxVoices) {
            const [oldestKey] = this.activeVoices.keys();
            this.activeVoices.delete(oldestKey);
        }

        // Create unique voice ID and voice
        const voiceId = `${soundUrl}-${Date.now()}`;
        const voice = this.createOneOffVoice(soundUrl);
        this.activeVoices.set(voiceId, voice);

        // Update the audio graph with all active voices
        this.updateAudioGraph();

        // Clean up this specific voice instance after duration
        const timeoutId = setTimeout(() => {
          this.activeVoices.delete(voiceId);
          this.voiceTimeouts.delete(voiceId);
          this.updateAudioGraph();
        }, duration * 1000);
        
        this.voiceTimeouts.set(voiceId, timeoutId);
    }

    createTrajectoryContainer() {
        const container = document.createElement('div');
        container.classList.add('trajectories-container');
        return container;
    }

    createTrajectoryElement(trajectoryId) {
        const el = document.createElement('div');
        el.classList.add('trajectory-item');
        el.innerHTML = `
            <span>Trajectory ${trajectoryId}</span>
            <button class="stop-trajectory">Stop</button>
            <button class="clear-trajectory">Clear</button>
        `;
        
        el.querySelector('.stop-trajectory').addEventListener('click', () => {
            this.stopTrajectoryPlayback(trajectoryId);
        });
        
        el.querySelector('.clear-trajectory').addEventListener('click', () => {
            this.clearTrajectory(trajectoryId);
            el.remove();
        });
        
        return el;
    }

    startTrajectoryRecording() {
        this.isRecording = true;
        this.currentRecordingId = Date.now();
        this.recordingStartTime = null;
        
        const trajectoryData = {
            events: [],
            isPlaying: false
        };
        
        this.trajectories.set(this.currentRecordingId, trajectoryData);
        
        // Add visual element
        const container = this.shadowRoot.querySelector('.trajectories-container');
        container.appendChild(this.createTrajectoryElement(this.currentRecordingId));
        
        console.log('Started recording new trajectory:', this.currentRecordingId);
    }

    recordEvent(element) {
        if (!this.currentRecordingId) return;
        
        const soundUrl = element.getAttribute('data-sound');
        const currentTime = this.recordingStartTime === null ? 
            0 : (Date.now() - this.recordingStartTime) / 1000;

        if (this.recordingStartTime === null) {
            this.recordingStartTime = Date.now();
        }

        const trajectory = this.trajectories.get(this.currentRecordingId);
        trajectory.events.push({
            time: currentTime,
            soundUrl: soundUrl
        });
    }

    stopTrajectoryRecording() {
        if (!this.isRecording || !this.currentRecordingId) return;
        
        const trajectory = this.trajectories.get(this.currentRecordingId);
        const currentTime = (Date.now() - this.recordingStartTime) / 1000;
        
        // Add end marker
        trajectory.events.push({
            time: currentTime,
            soundUrl: null
        });
        
        this.isRecording = false;
        this.playTrajectory(this.currentRecordingId);
        this.currentRecordingId = null;
        
        this.shadowRoot.querySelectorAll('.element').forEach(el => 
            el.classList.remove('recording'));
    }

    async playTrajectory(trajectoryId) {
        const trajectory = this.trajectories.get(trajectoryId);
        if (!trajectory || trajectory.events.length === 0) return;
        
        trajectory.isPlaying = true;
        
        // Create timing signal with unique key for this trajectory
        const ticker = el.train(100);
        
        const seq = trajectory.events.map((evt, i) => ({
            tickTime: Math.round(evt.time * 100)+1, // +1 so that the first tick is within the loop range, and not at its edge
            value: i+1, // +1 to have all sound ticks non-zero
            soundUrl: evt.soundUrl
        }));
        const firstTick = seq[0].tickTime-1; // -1 so that the first tick is within the loop range, and not at its edge
        const latestEndpoint = seq[seq.length - 1].tickTime;
        
        const masterSeq = el.sparseq({
            key: `trajectory-${trajectoryId}-master`,
            seq: seq,
            loop: [firstTick, latestEndpoint]
        }, ticker, el.const({value: 0}));
        
        const players = seq
            .filter(event => event.soundUrl)
            .map((event, index) => {
                const trigger = el.eq(
                    masterSeq,
                    el.const({key: `event-${trajectoryId}-${index}-value`, value: index+1}) // +1 to match with the "seq" declaration above, to have all sound ticks non-zero
                );
                
                return el.mc.sample({
                    channels: 1,
                    key: `player-${trajectoryId}-${index}`,
                    path: event.soundUrl,
                    mode: 'trigger',
                    playbackRate: this.sampleParams.playbackRate,
                    startOffset: this.sampleParams.startOffset,
                    endOffset: this.sampleParams.endOffset
                }, trigger, el.const({key: `rate-${trajectoryId}-${index}`, value: 1}))[0];
            });
        
        let signal = players.length === 1 ? 
            el.mul(players[0], el.const({key: `gain-${trajectoryId}`, value: 1 / this.maxVoices})) :
            el.mul(el.add(...players), el.const({key: `gain-${trajectoryId}`, value: 1 / this.maxVoices}));
        
        this.activeTrajectorySignals.set(trajectoryId, signal);
        this.updateAudioGraph();
    }

    stopTrajectoryPlayback(trajectoryId) {
        const trajectory = this.trajectories.get(trajectoryId);
        if (trajectory) {
            trajectory.isPlaying = false;
            this.activeTrajectorySignals.delete(trajectoryId);
            this.updateAudioGraph();
        }
    }

    clearTrajectory(trajectoryId) {
        this.stopTrajectoryPlayback(trajectoryId);
        this.trajectories.delete(trajectoryId);
    }

    createSequenceControls(sequenceId) {
        const container = document.createElement('div');
        container.classList.add('sequence-controls');
        container.innerHTML = `
            <div class="sequence-header">
                <h3>Sequence ${sequenceId}</h3>
                <div class="sequence-buttons">
                    <button class="activate-sequence" data-id="${sequenceId}">
                        ${this.activeSequenceId === sequenceId ? 'Active' : 'Activate'}
                    </button>
                    <button class="clear-sequence" data-id="${sequenceId}" disabled>Clear</button>
                    <button class="remove-sequence" data-id="${sequenceId}">Remove</button>
                </div>
            </div>
            <div class="sequence-controls-row">
                <div class="sequence-volume">
                    <input type="range" class="volume-slider" 
                           data-id="${sequenceId}" min="0" max="1" step="0.01" value="1">
                    <span class="volume-value">100%</span>
                </div>
                <div class="sequence-buttons">
                    <button class="mute-sequence" data-id="${sequenceId}">Mute</button>
                    <button class="solo-sequence" data-id="${sequenceId}">Solo</button>
                </div>
            </div>
            <div class="sequence-parameters">
                <div class="parameter-group">
                    <label>Bars:</label>
                    <select class="sequence-bars" data-id="${sequenceId}">
                        <option value="1/4 bar">1/4 bar</option>
                        <option value="1/2 bar">1/2 bar</option>
                        <option value="1 bar" selected>1 bar</option>
                        <option value="2 bars">2 bars</option>
                        <option value="3 bars">3 bars</option>
                        <option value="4 bars">4 bars</option>
                        <option value="8 bars">8 bars</option>
                    </select>
                </div>
                <div class="parameter-group">
                    <label>Sequence Start Offset: <span class="start-offset-value">0%</span></label>
                    <input type="range" class="sequence-start-offset" 
                           data-id="${sequenceId}" min="0" max="1" step="0.01" value="0">
                </div>
            </div>
            <div class="sequence-elements" data-id="${sequenceId}"></div>
        `;

        // Add styles specific to the new controls
        const style = document.createElement('style');
        style.textContent = `
            .sequence-controls-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 10px;
            }
            .sequence-volume {
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .volume-slider {
                width: 100px;
            }
            .mute-sequence.active, .solo-sequence.active {
                background-color: #ff4444;
                color: white;
            }
            .solo-sequence.active {
                background-color: #ffaa00;
            }
        `;
        container.appendChild(style);

        this.setupSequenceControlHandlers(container, sequenceId);
        this.updateSequenceActiveState(container, sequenceId);
        return container;
    }

    setupSequenceControlHandlers(container, sequenceId) {
        const activateBtn = container.querySelector(`.activate-sequence[data-id="${sequenceId}"]`);
        const clearBtn = container.querySelector(`.clear-sequence[data-id="${sequenceId}"]`);
        const removeBtn = container.querySelector(`.remove-sequence[data-id="${sequenceId}"]`);
        const barsSelect = container.querySelector(`.sequence-bars[data-id="${sequenceId}"]`);

        activateBtn.addEventListener('click', () => {
            // Deactivate current active sequence if any
            if (this.activeSequenceId && this.activeSequenceId !== sequenceId) {
                const prevSequence = this.sequences.get(this.activeSequenceId);
                if (prevSequence) {
                    prevSequence.isRecording = false;
                }
                this.updateAllSequenceControls();
            }

            // Toggle active state for clicked sequence
            if (this.activeSequenceId === sequenceId) {
                this.activeSequenceId = null;
                this.sequences.get(sequenceId).isRecording = false;
                clearBtn.disabled = true;
            } else {
                this.activeSequenceId = sequenceId;
                this.sequences.get(sequenceId).isRecording = true;
                clearBtn.disabled = false;
            }

            this.updateAllSequenceControls();
        });

        clearBtn.addEventListener('click', () => {
            const sequence = this.sequences.get(sequenceId);
            sequence.clear();
            this.sequenceSignals.delete(sequenceId);
            this.updateAudioGraph();
            sequence.isRecording = false;
            this.activeSequenceId = null;
            this.updateAllSequenceControls();
            container.querySelector(`.sequence-elements[data-id="${sequenceId}"]`).innerHTML = '';
            this.shadowRoot.querySelectorAll('.element').forEach(el => {
                el.classList.remove(`in-sequence-${sequenceId}`);
            });
        });

        removeBtn.addEventListener('click', () => {
            this.sequences.delete(sequenceId);
            this.sequenceSignals.delete(sequenceId);
            container.remove();
            this.updateAudioGraph();
        });

        barsSelect.addEventListener('change', (e) => {
            const sequence = this.sequences.get(sequenceId);
            sequence.bars = e.target.value;
            this.updateSequencePlayback(sequenceId);
        });

        const volumeSlider = container.querySelector(`.volume-slider[data-id="${sequenceId}"]`);
        const volumeValue = container.querySelector('.volume-value');
        const muteBtn = container.querySelector(`.mute-sequence[data-id="${sequenceId}"]`);
        const soloBtn = container.querySelector(`.solo-sequence[data-id="${sequenceId}"]`);

        volumeSlider.addEventListener('input', (e) => {
            const volume = parseFloat(e.target.value);
            const sequence = this.sequences.get(sequenceId);
            sequence.volume = volume;
            volumeValue.textContent = `${Math.round(volume * 100)}%`;
            this.updateSequencePlayback(sequenceId);
        });

        muteBtn.addEventListener('click', () => {
            const sequence = this.sequences.get(sequenceId);
            sequence.isMuted = !sequence.isMuted;
            muteBtn.classList.toggle('active', sequence.isMuted);
            this.updateSequencePlayback(sequenceId);
        });

        soloBtn.addEventListener('click', () => {
            const sequence = this.sequences.get(sequenceId);
            sequence.isSolo = !sequence.isSolo;
            
            if (sequence.isSolo) {
                this.soloSequences.add(sequenceId);
            } else {
                this.soloSequences.delete(sequenceId);
            }
            
            soloBtn.classList.toggle('active', sequence.isSolo);
            
            // Update all sequences since solo affects them all
            this.sequences.forEach((_, id) => this.updateSequencePlayback(id));
        });

        const startOffsetSlider = container.querySelector(`.sequence-start-offset[data-id="${sequenceId}"]`);
        const startOffsetValue = container.querySelector('.start-offset-value');

        startOffsetSlider.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            const sequence = this.sequences.get(sequenceId);
            sequence.startOffset = value;
            startOffsetValue.textContent = `${Math.round(value * 100)}%`;
            this.updateSequencePlayback(sequenceId);
        });
    }

    updateSequenceActiveState(container, sequenceId) {
        const isActive = this.activeSequenceId === sequenceId;
        container.classList.toggle('active-sequence', isActive);
        const activateBtn = container.querySelector(`.activate-sequence[data-id="${sequenceId}"]`);
        if (activateBtn) {
            activateBtn.textContent = isActive ? 'Active' : 'Activate';
            activateBtn.classList.toggle('active', isActive);
        }
    }

    updateAllSequenceControls() {
        this.shadowRoot.querySelectorAll('.sequence-controls').forEach(container => {
            const sequenceId = container.querySelector('[data-id]').dataset.id;
            this.updateSequenceActiveState(container, sequenceId);
        });
    }

    updateSequenceElementsUI(sequenceId) {
        const sequence = this.sequences.get(sequenceId);
        const sequenceElements = this.shadowRoot.querySelector(`.sequence-elements[data-id="${sequenceId}"]`);
        sequenceElements.innerHTML = '';
        
        sequence.elements.forEach((element, index) => {
            const elementDiv = document.createElement('div');
            elementDiv.classList.add('sequence-element');
            elementDiv.innerHTML = `
                <span>Element ${index + 1}</span>
                <div class="parameter-sliders">
                    <div class="parameter-slider">
                        <label>Sequence Offset</label>
                        <input type="range" min="0.1" max="2" step="0.1" value="${element.offset}" 
                               class="offset-slider" data-sequence="${sequenceId}" data-index="${index}">
                        <span class="parameter-value">${element.offset}x</span>
                    </div>
                    <div class="parameter-slider">
                        <label>Duration Scale</label>
                        <input type="range" min="0.1" max="10" step="0.1" value="${element.duration}" 
                               class="duration-slider" data-sequence="${sequenceId}" data-index="${index}">
                        <span class="parameter-value">${element.duration}x</span>
                    </div>
                    <div class="parameter-slider">
                        <label>Pitch Shift</label>
                        <input type="range" min="-24" max="24" step="1" value="${element.shift}" 
                               class="shift-slider" data-sequence="${sequenceId}" data-index="${index}">
                        <span class="parameter-value">${element.shift} st</span>
                    </div>
                    <div class="parameter-slider">
                        <label>Sample Stretch</label>
                        <input type="range" min="0.25" max="4" step="0.25" value="${element.stretch}" 
                               class="stretch-slider" data-sequence="${sequenceId}" data-index="${index}">
                        <span class="parameter-value">${element.stretch}x</span>
                    </div>
                </div>
                <button class="remove-element" data-sequence="${sequenceId}" data-index="${index}">✕</button>
            `;
            
            const offsetSlider = elementDiv.querySelector('.offset-slider');
            const shiftSlider = elementDiv.querySelector('.shift-slider');
            const stretchSlider = elementDiv.querySelector('.stretch-slider');
            const durationSlider = elementDiv.querySelector('.duration-slider');
            
            offsetSlider.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                this.sequences.get(sequenceId).setOffset(parseInt(e.target.dataset.index), value);
                e.target.nextElementSibling.textContent = `${value}x`;
                this.updateSequencePlayback(sequenceId);
            });

            shiftSlider.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                this.sequences.get(sequenceId).setShift(parseInt(e.target.dataset.index), value);
                e.target.nextElementSibling.textContent = `${value} st`;
                this.updateSequencePlayback(sequenceId);
            });

            stretchSlider.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                this.sequences.get(sequenceId).setStretch(parseInt(e.target.dataset.index), value);
                e.target.nextElementSibling.textContent = `${value}x`;
                this.updateSequencePlayback(sequenceId);
            });

            durationSlider.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                this.sequences.get(sequenceId).setDuration(parseInt(e.target.dataset.index), value);
                e.target.nextElementSibling.textContent = `${value}x`;
                this.updateSequencePlayback(sequenceId);
            });

            elementDiv.querySelector('.remove-element').addEventListener('click', (e) => {
                const index = parseInt(e.target.dataset.index);
                const removedSound = this.sequences.get(sequenceId).elements[index].soundUrl;
                this.sequences.get(sequenceId).removeElement(index);
                
                // Find and remove highlight from the corresponding element if it's not used anymore
                if (!this.sequences.get(sequenceId).elements.some(el => el.soundUrl === removedSound)) {
                    this.shadowRoot.querySelector(`[data-sound="${removedSound}"]`)?.classList.remove(`in-sequence-${sequenceId}`);
                }
                
                this.updateSequenceElementsUI(sequenceId);
                this.updateSequencePlayback(sequenceId);
            });
            
            sequenceElements.appendChild(elementDiv);
        });
    }

    connectedCallback() {
        this.shadowRoot.innerHTML = `
            <style>
                :host {
                    display: block;
                }
                .container {
                    padding: 20px;
                }
                .element {
                    padding: 20px;
                    margin: 10px;
                    background-color: var(--primary-color, #444);
                    color: white;
                    border-radius: 8px;
                    cursor: pointer;
                    transition: background-color 0.3s;
                }
                .element.looping {
                    background-color: #008800;
                }
                .mode-buttons {
                    margin-bottom: 20px;
                }
                .mode-buttons button {
                    margin-right: 10px;
                    padding: 8px 16px;
                }
                .control-panel {
                    margin: 20px 0;
                    display: flex;
                    flex-wrap: wrap;
                    gap: 40px;
                }
                .control-group {
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                }
                .control-group h3 {
                    margin: 0;
                }
                .radio-group {
                    display: flex;
                    gap: 15px;
                }
                .radio-group label {
                    display: flex;
                    align-items: center;
                    gap: 5px;
                }
                .trajectory-controls {
                    display: flex;
                    gap: 10px;
                }
                .trajectory-controls button {
                    padding: 8px 16px;
                    cursor: pointer;
                }
                .trajectory-controls button:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }
                .recording {
                    background-color: #ff4444 !important;
                }
                .trajectories-container {
                    margin: 20px 0;
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                }
                .trajectory-item {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 10px;
                    background: #f0f0f0;
                    border-radius: 4px;
                }
                .trajectory-item button {
                    padding: 5px 10px;
                    cursor: pointer;
                }
                .sequence-controls {
                    margin: 20px 0;
                    padding: 15px;
                    background: #f5f5f5;
                    border-radius: 8px;
                }
                .sequence-buttons {
                    display: flex;
                    gap: 10px;
                    margin-bottom: 15px;
                }
                .sequence-parameters {
                    display: flex;
                    gap: 20px;
                    align-items: center;
                }
                .parameter-group {
                    display: flex;
                    flex-direction: column;
                    gap: 5px;
                }
                .parameter-group label {
                    font-size: 0.9em;
                    color: #666;
                }
                .sequence-elements {
                    margin-top: 15px;
                }
                .sequence-element {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    margin: 5px 0;
                    padding: 8px;
                    background: #fff;
                    border-radius: 4px;
                }
                .sequence-element input[type="range"] {
                    flex: 1;
                }
                .element.in-sequence {
                    background-color: #4488ff;
                }
                .remove-element {
                    padding: 2px 6px;
                    border-radius: 4px;
                    border: 1px solid #ccc;
                    background: #fff;
                    cursor: pointer;
                    font-size: 12px;
                    color: #666;
                }
                .remove-element:hover {
                    background: #ff4444;
                    color: white;
                    border-color: #dd2222;
                }
                .parameter-sliders {
                    display: flex;
                    gap: 10px;
                    align-items: center;
                }
                .parameter-slider {
                    display: flex;
                    flex-direction: column;
                    gap: 5px;
                }
                .parameter-value {
                    font-size: 0.8em;
                    color: #666;
                }
                .sample-parameters {
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                    margin-top: 10px;
                }
                .sample-parameter {
                    display: flex;
                    flex-direction: column;
                    gap: 5px;
                }
                .parameter-label {
                    display: flex;
                    justify-content: space-between;
                    font-size: 0.9em;
                }
                .sequence-container {
                    display: flex;
                    flex-direction: column;
                    gap: 20px;
                }
                .sequence-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                .global-controls {
                    margin: 20px 0;
                    padding: 15px;
                    background: #f5f5f5;
                    border-radius: 8px;
                }
                .sequence-controls.active-sequence {
                    border: 2px solid #4CAF50;
                    background-color: #f0f7f0;
                }
                .activate-sequence.active {
                    background-color: #4CAF50;
                    color: white;
                }
            </style>
            <div class="container">
                <h1><a href="https://www.elementary.audio">Elementary.audio</a> sample sequencing test</h1>
                <button id="init-audio">Initialize Audio</button>
                
                <div class="control-panel">
                    <div class="control-group">
                        <h3>Mode</h3>
                        <div class="radio-group">
                            <label>
                                <input type="radio" name="mode" value="explore one-off" checked>
                                Explore One-Off
                            </label>
                            <label>
                                <input type="radio" name="mode" value="explore looping">
                                Explore Looping
                            </label>
                        </div>
                    </div>
                    <div class="control-group">
                        <h3>Interaction</h3>
                        <div class="radio-group">
                            <label>
                                <input type="radio" name="interaction" value="hover" checked>
                                Hover
                            </label>
                            <label>
                                <input type="radio" name="interaction" value="click">
                                Click
                            </label>
                        </div>
                    </div>
                    <div class="control-group">
                        <h3>Trajectory</h3>
                        <div class="trajectory-controls">
                            <button id="start-recording">Start Recording</button>
                            <button id="stop-recording" disabled>Stop Recording</button>
                        </div>
                        <div class="sample-parameters">
                            <div class="sample-parameter">
                                <div class="parameter-label">
                                    <span>Playback Rate</span>
                                    <span id="playback-rate-value">1.0</span>
                                </div>
                                <input type="range" id="playback-rate" 
                                    min="0.25" max="4" step="0.25" value="1">
                            </div>
                            <div class="sample-parameter">
                                <div class="parameter-label">
                                    <span>Start Offset</span>
                                    <span id="start-offset-value">0</span>
                                </div>
                                <input type="range" id="start-offset" 
                                    min="0" max="44100" step="441" value="0">
                            </div>
                            <div class="sample-parameter">
                                <div class="parameter-label">
                                    <span>End Offset</span>
                                    <span id="end-offset-value">0</span>
                                </div>
                                <input type="range" id="end-offset" 
                                    min="0" max="44100" step="441" value="0">
                            </div>
                        </div>
                    </div>
                </div>

                <div class="global-controls">
                    <h3>Global Settings</h3>
                    <div class="parameter-group">
                        <label>BPM: <span id="bpm-value">120</span></label>
                        <input type="range" id="global-bpm" min="10" max="300" value="120">
                    </div>
                    <button id="add-sequence">Add Sequence</button>
                </div>
                <div class="sequence-container"></div>

                <div id="content">
                    <div class="element" data-sound="https://ns9648k.web.sigma2.no/evoConf_singleMap_refSingleEmb_mfcc-sans0-statistics_pca_retrainIncr50_zScoreNSynthTrain_bassSynth/01JCVR4RSQNYCM6PFBZC0TZ0HD_evoConf_singleMap_refSingleEmb_mfcc-sans0-statistics_pca_retrainIncr50_zScoreNSynthTrain_bassSynth/01JCXDE8GYPBGY6579CNEVDESS-4_0_1.wav">Element 1</div>
                    <div class="element" data-sound="https://ns9648k.web.sigma2.no/evoConf_singleMap_refSingleEmb_mfcc-sans0-statistics_pca_retrainIncr50_zScoreNSynthTrain_bassSynth/01JCVR4RSQNYCM6PFBZC0TZ0HD_evoConf_singleMap_refSingleEmb_mfcc-sans0-statistics_pca_retrainIncr50_zScoreNSynthTrain_bassSynth/01JCXC5834FMVTRV3C6PZ1MH4E-4_0_1.wav">Element 2</div>
                    <div class="element" data-sound="https://ns9648k.web.sigma2.no/evoConf_singleMap_refSingleEmb_mfcc-sans0-statistics_pca_retrainIncr50_zScoreNSynthTrain_bassSynth/01JCVR4RSQNYCM6PFBZC0TZ0HD_evoConf_singleMap_refSingleEmb_mfcc-sans0-statistics_pca_retrainIncr50_zScoreNSynthTrain_bassSynth/01JCX1R8B6A9QSMPEJ7D1C2WY1-4_0_1.wav">Element 3</div>
                </div>
                <div class="trajectories-container"></div>
            </div>
        `;

        const initAudioButton = this.shadowRoot.querySelector('#init-audio');
        initAudioButton.addEventListener('click', async () => {
            const success = await this.initializeAudio();
            if (success) {
                initAudioButton.disabled = true;
            }
        });

        const modeButtons = this.shadowRoot.querySelectorAll('input[name="mode"]');
        modeButtons.forEach(button => {
            button.addEventListener('change', (e) => {
                this.mode = e.target.value;
                this.updateAudioGraph();
            });
        });

        const interactionButtons = this.shadowRoot.querySelectorAll('input[name="interaction"]');
        interactionButtons.forEach(button => {
            button.addEventListener('change', (e) => {
                this.interactionMode = e.target.value;
            });
        });

        const startRecordingButton = this.shadowRoot.querySelector('#start-recording');
        const stopRecordingButton = this.shadowRoot.querySelector('#stop-recording');

        startRecordingButton.addEventListener('click', () => {
            this.startTrajectoryRecording();
            startRecordingButton.disabled = true;
            stopRecordingButton.disabled = false;
            this.shadowRoot.querySelectorAll('.element').forEach(el => 
                el.classList.add('recording'));
        });

        stopRecordingButton.addEventListener('click', () => {
            this.stopTrajectoryRecording();
            startRecordingButton.disabled = false;
            stopRecordingButton.disabled = true;
        });

        this.shadowRoot.querySelectorAll('.element').forEach(element => {
            element.addEventListener(this.interactionMode === 'hover' ? 'mouseenter' : 'click', async () => {
                if (this.mode === 'explore looping') {
                    await this.toggleLoopingSound(element);
                } else if (this.mode === 'explore one-off') {
                    await this.playOneOffSound(element);
                }

                if (this.isRecording) {
                    this.recordEvent(element);
                }
            });
        });

        // Add global BPM control
        const globalBpmSlider = this.shadowRoot.querySelector('#global-bpm');
        const bpmValue = this.shadowRoot.querySelector('#bpm-value');

        globalBpmSlider.addEventListener('input', (e) => {
            this.globalBpm = parseInt(e.target.value);
            bpmValue.textContent = this.globalBpm;
            // Update all sequences
            this.sequences.forEach((sequence, id) => {
                sequence.bpm = this.globalBpm;
                this.updateSequencePlayback(id);
            });
        });

        // Add sequence button handler
        this.shadowRoot.querySelector('#add-sequence').addEventListener('click', () => {
            const sequenceId = Date.now();
            const sequence = new Sequence();
            sequence.bpm = this.globalBpm;
            this.sequences.set(sequenceId, sequence);

            const container = this.shadowRoot.querySelector('.sequence-container');
            container.appendChild(this.createSequenceControls(sequenceId));
        });

        // Modify existing element click handler
        this.shadowRoot.querySelectorAll('.element').forEach(element => {
            const originalClickHandler = element.onclick;
            element.onclick = async (event) => {
                if (!this.initialized) return;

                // Only record to active sequence
                if (this.activeSequenceId) {
                    const sequence = this.sequences.get(this.activeSequenceId);
                    if (sequence && sequence.isRecording) {
                        const soundUrl = element.getAttribute('data-sound');
                        
                        if (!this.uploadedSamples.has(soundUrl)) {
                            try {
                                const res = await fetch(soundUrl);
                                const sampleBuffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
                                
                                await this.core.updateVirtualFileSystem({
                                    [soundUrl]: [sampleBuffer.getChannelData(0)]
                                });
                                
                                this.uploadedSamples.add(soundUrl);
                                this.sampleDurations.set(soundUrl, sampleBuffer.duration);
                            } catch (error) {
                                console.error('Failed to load sample:', error);
                                return;
                            }
                        }

                        sequence.addElement(soundUrl);
                        element.classList.add(`in-sequence-${this.activeSequenceId}`);
                        
                        this.updateSequenceElementsUI(this.activeSequenceId);
                        this.updateSequencePlayback(this.activeSequenceId);
                        return;
                    }
                }

                // Handle original click behavior if no sequence is recording
                if (originalClickHandler) {
                    originalClickHandler(event);
                }
            };
        });

        // Add sample parameter control handlers
        const playbackRateSlider = this.shadowRoot.querySelector('#playback-rate');
        const startOffsetSlider = this.shadowRoot.querySelector('#start-offset');
        const endOffsetSlider = this.shadowRoot.querySelector('#end-offset');

        playbackRateSlider.addEventListener('input', (e) => {
            this.sampleParams.playbackRate = parseFloat(e.target.value);
            this.shadowRoot.querySelector('#playback-rate-value').textContent = 
                this.sampleParams.playbackRate.toFixed(2);
            
            // Recreate all active looping voices with new parameters
            if (this.loopingVoices.size > 0) {
                const activeLoops = Array.from(this.loopingVoices.keys());
                activeLoops.forEach(soundUrl => {
                    const duration = this.sampleDurations.get(soundUrl);
                    const loopingVoice = this.createLoopingVoice(soundUrl, duration);
                    this.loopingVoices.set(soundUrl, loopingVoice);
                });
                this.updateAudioGraph();
            }
        });

        startOffsetSlider.addEventListener('input', (e) => {
            this.sampleParams.startOffset = parseInt(e.target.value);
            this.shadowRoot.querySelector('#start-offset-value').textContent = 
                this.sampleParams.startOffset;
            
            if (this.loopingVoices.size > 0) {
                const activeLoops = Array.from(this.loopingVoices.keys());
                activeLoops.forEach(soundUrl => {
                    const duration = this.sampleDurations.get(soundUrl);
                    const loopingVoice = this.createLoopingVoice(soundUrl, duration);
                    this.loopingVoices.set(soundUrl, loopingVoice);
                });
                this.updateAudioGraph();
            }
        });

        endOffsetSlider.addEventListener('input', (e) => {
            this.sampleParams.endOffset = parseInt(e.target.value);
            this.shadowRoot.querySelector('#end-offset-value').textContent = 
                this.sampleParams.endOffset;
            
            if (this.loopingVoices.size > 0) {
                const activeLoops = Array.from(this.loopingVoices.keys());
                activeLoops.forEach(soundUrl => {
                    const duration = this.sampleDurations.get(soundUrl);
                    const loopingVoice = this.createLoopingVoice(soundUrl, duration);
                    this.loopingVoices.set(soundUrl, loopingVoice);
                });
                this.updateAudioGraph();
            }
        });

        // Add styles for active sequence
        const style = document.createElement('style');
        style.textContent = `
            .sequence-controls.active-sequence {
                border: 2px solid #4CAF50;
                background-color: #f0f7f0;
            }
            .activate-sequence.active {
                background-color: #4CAF50;
                color: white;
            }
        `;
        this.shadowRoot.appendChild(style);
    }
}

customElements.define('test-component', TestComponent);