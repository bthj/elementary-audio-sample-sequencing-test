import {el} from '@elemaudio/core';
import WebRenderer from '@elemaudio/web-renderer';

// Add new Sequence class before TestComponent
class Sequence {
    constructor() {
        this.elements = [];
        this.bpm = 120;
        this.bars = "1 bar";
        this.isRecording = false;
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

        // Add sequence state
        this.sequence = new Sequence();
        this.sequenceSignal = null;
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
                  playbackRate: 1,
                  startOffset: 0,
                  endOffset: 0
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

        // Create a looping sequence with the sample
        return el.mul(
            el.sampleseq2({
                path: soundUrl,
                duration: duration,
                seq: [{ time: 0, value: 1 }]
            }, time),
            el.const({ value: 1 / this.maxVoices }) // Dynamic gain scaling
        );
    }

    createSequenceVoices() {
        if (this.sequence.elements.length === 0) return null;

        const sequenceDuration = this.sequence.getDurationInSeconds();
        const times = this.sequence.getElementTimes();
        try {
            // Create array of sample sequencers
            const voices = this.sequence.elements.map((element, index) => {
                if (!this.uploadedSamples.has(element.soundUrl)) {
                    console.warn('Sample not loaded:', element.soundUrl);
                    return null;
                }

                const sampleDuration = this.sampleDurations.get(element.soundUrl);
                const startTime = times[index] * sequenceDuration;
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
                el.mul(voices[0], el.const({value: 1 / this.maxVoices})) :
                el.mul(el.add(...voices), el.const({value: 1 / this.maxVoices}));
        } catch (error) {
            console.error('Error in createSequenceVoices:', error);
            return null;
        }
    }

    updateSequencePlayback() {
        try {
            this.sequenceSignal = this.createSequenceVoices();
            this.updateAudioGraph();
        } catch (error) {
            console.error('Error in updateSequencePlayback:', error);
            this.sequenceSignal = null;
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

        // Add sequence signal if active
        if (this.sequenceSignal) {
            signal = signal ? el.add(signal, this.sequenceSignal) : this.sequenceSignal;
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
                    playbackRate: 1,
                    startOffset: 0,
                    endOffset: 0
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
            </style>
            <div class="container">
                <h1>Elementary Audio Test</h1>
                <button id="init-audio">Initialize Audio</button>
                
                <div class="control-panel">
                    <div class="control-group">
                        <h3>Playback Mode</h3>
                        <div class="radio-group">
                            <label>
                                <input type="radio" name="playback" value="explore one-off" checked>
                                One-off
                            </label>
                            <label>
                                <input type="radio" name="playback" value="explore looping">
                                Looping
                            </label>
                        </div>
                    </div>

                    <div class="control-group">
                        <h3>Interaction Mode</h3>
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
                            <button id="record-trajectory">Record Trajectory</button>
                            <button id="stop-trajectory" disabled>Stop Recording</button>
                        </div>
                    </div>
                </div>

                <div id="content">
                    <div class="element" data-sound="https://ns9648k.web.sigma2.no/evoConf_singleMap_refSingleEmb_mfcc-sans0-statistics_pca_retrainIncr50_zScoreNSynthTrain_bassSynth/01JCVR4RSQNYCM6PFBZC0TZ0HD_evoConf_singleMap_refSingleEmb_mfcc-sans0-statistics_pca_retrainIncr50_zScoreNSynthTrain_bassSynth/01JCXDE8GYPBGY6579CNEVDESS-4_0_1.wav">Element 1</div>
                    <div class="element" data-sound="https://ns9648k.web.sigma2.no/evoConf_singleMap_refSingleEmb_mfcc-sans0-statistics_pca_retrainIncr50_zScoreNSynthTrain_bassSynth/01JCVR4RSQNYCM6PFBZC0TZ0HD_evoConf_singleMap_refSingleEmb_mfcc-sans0-statistics_pca_retrainIncr50_zScoreNSynthTrain_bassSynth/01JCXC5834FMVTRV3C6PZ1MH4E-4_0_1.wav">Element 2</div>
                    <div class="element" data-sound="https://ns9648k.web.sigma2.no/evoConf_singleMap_refSingleEmb_mfcc-sans0-statistics_pca_retrainIncr50_zScoreNSynthTrain_bassSynth/01JCVR4RSQNYCM6PFBZC0TZ0HD_evoConf_singleMap_refSingleEmb_mfcc-sans0-statistics_pca_retrainIncr50_zScoreNSynthTrain_bassSynth/01JCX1R8B6A9QSMPEJ7D1C2WY1-4_0_1.wav">Element 3</div>
                </div>
                <div class="trajectories-container"></div>
                <div class="sequence-controls">
                    <div class="sequence-buttons">
                        <button id="record-sequence">Record Sequence</button>
                        <button id="clear-sequence" disabled>Clear Sequence</button>
                    </div>
                    <div class="sequence-parameters">
                        <div class="parameter-group">
                            <label>Bars:</label>
                            <select id="sequence-bars">
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
                            <label>BPM: <span id="bpm-value">120</span></label>
                            <input type="range" id="sequence-bpm" min="10" max="300" value="120">
                        </div>
                    </div>
                    <div class="sequence-elements"></div>
                </div>
            </div>
        `;

        const initButton = this.shadowRoot.querySelector('#init-audio');
        initButton.addEventListener('click', async () => {
            if (await this.initializeAudio()) {
                initButton.disabled = true;
                initButton.textContent = 'Audio Ready';
            }
        });

        // Mode selection handlers
        this.shadowRoot.querySelectorAll('input[name="playback"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                this.setMode(e.target.value);
            });
        });

        // Interaction mode selection handlers
        this.shadowRoot.querySelectorAll('input[name="interaction"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                this.interactionMode = e.target.value;
            });
        });

        // Trajectory control handlers
        const recordButton = this.shadowRoot.querySelector('#record-trajectory');
        const stopButton = this.shadowRoot.querySelector('#stop-trajectory');

        recordButton.addEventListener('click', () => {
            this.startTrajectoryRecording();
            recordButton.disabled = true;
            stopButton.disabled = false;
            this.shadowRoot.querySelectorAll('.element').forEach(el => 
                el.classList.add('recording'));
        });

        stopButton.addEventListener('click', () => {
            this.stopTrajectoryRecording();
            recordButton.disabled = false;
            stopButton.disabled = true;
            this.shadowRoot.querySelectorAll('.element').forEach(el => 
                el.classList.remove('recording'));
        });

        // Add sequence control event listeners
        const recordSequenceBtn = this.shadowRoot.querySelector('#record-sequence');
        const clearSequenceBtn = this.shadowRoot.querySelector('#clear-sequence');
        const barsSelect = this.shadowRoot.querySelector('#sequence-bars');
        const bpmSlider = this.shadowRoot.querySelector('#sequence-bpm');
        const bpmValue = this.shadowRoot.querySelector('#bpm-value');

        recordSequenceBtn.addEventListener('click', () => {
            this.sequence.isRecording = true;
            recordSequenceBtn.disabled = true;
            clearSequenceBtn.disabled = false;
        });

        clearSequenceBtn.addEventListener('click', () => {
            this.sequence.clear();
            this.sequenceSignal = null;
            this.updateAudioGraph();
            this.sequence.isRecording = false;
            recordSequenceBtn.disabled = false;
            clearSequenceBtn.disabled = true;
            this.shadowRoot.querySelector('.sequence-elements').innerHTML = '';
            this.shadowRoot.querySelectorAll('.element').forEach(el => {
                el.classList.remove('in-sequence');
            });
        });

        barsSelect.addEventListener('change', (e) => {
            this.sequence.bars = e.target.value;
            this.updateSequencePlayback();
        });

        bpmSlider.addEventListener('input', (e) => {
            this.sequence.bpm = parseInt(e.target.value);
            bpmValue.textContent = this.sequence.bpm;
            this.updateSequencePlayback();
        });

        // Sound element event handlers
        this.shadowRoot.querySelectorAll('.element').forEach(element => {
            // Handler for hover interactions
            element.addEventListener('mouseenter', () => {
                if (!this.initialized) return;

                if (this.interactionMode === 'hover' && !this.isPlayingTrajectory) {
                    if (this.isRecording) {
                        this.recordEvent(element);
                    }
                    if (this.mode === 'explore one-off') {
                        this.playOneOffSound(element);
                    } else if (this.mode === 'explore looping') {
                        this.toggleLoopingSound(element);
                    }
                }
            });

            // Handler for click interactions
            element.addEventListener('click', () => {
                if (!this.initialized) return;

                if (this.interactionMode === 'click' && !this.isPlayingTrajectory) {
                    if (this.isRecording) {
                        this.recordEvent(element);
                    }
                    if (this.mode === 'explore one-off') {
                        this.playOneOffSound(element);
                    } else if (this.mode === 'explore looping') {
                        this.toggleLoopingSound(element);
                    }
                }
            });

            const originalClickHandler = element.onclick;
            element.onclick = async (event) => {
                if (!this.initialized) return;

                if (this.sequence.isRecording) {
                    const soundUrl = element.getAttribute('data-sound');
                    
                    // Ensure sample is loaded into virtual file system
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

                    this.sequence.addElement(soundUrl);
                    element.classList.add('in-sequence');
                    
                    this.updateSequenceElementsUI();

                    try {
                        this.updateSequencePlayback();
                    } catch (error) {
                        console.error('Failed to update sequence playback:', error);
                    }
                } else if (originalClickHandler) {
                    originalClickHandler(event);
                }
            };
        });
    }

    updateSequenceElementsUI() {
        const sequenceElements = this.shadowRoot.querySelector('.sequence-elements');
        sequenceElements.innerHTML = '';
        
        this.sequence.elements.forEach((element, index) => {
            const elementDiv = document.createElement('div');
            elementDiv.classList.add('sequence-element');
            elementDiv.innerHTML = `
                <span>Element ${index + 1}</span>
                <div class="parameter-sliders">
                    <div class="parameter-slider">
                        <label>Sequence Offset</label>
                        <input type="range" min="0.1" max="2" step="0.1" value="${element.offset}" 
                               class="offset-slider" data-index="${index}">
                        <span class="parameter-value">${element.offset}x</span>
                    </div>
                    <div class="parameter-slider">
                        <label>Duration Scale</label>
                        <input type="range" min="0.1" max="10" step="0.1" value="${element.duration}" 
                               class="duration-slider" data-index="${index}">
                        <span class="parameter-value">${element.duration}x</span>
                    </div>
                    <div class="parameter-slider">
                        <label>Pitch Shift</label>
                        <input type="range" min="-24" max="24" step="1" value="${element.shift}" 
                               class="shift-slider" data-index="${index}">
                        <span class="parameter-value">${element.shift} st</span>
                    </div>
                    <div class="parameter-slider">
                        <label>Sample Stretch</label>
                        <input type="range" min="0.25" max="4" step="0.25" value="${element.stretch}" 
                               class="stretch-slider" data-index="${index}">
                        <span class="parameter-value">${element.stretch}x</span>
                    </div>
                </div>
                <button class="remove-element" data-index="${index}">✕</button>
            `;
            
            const offsetSlider = elementDiv.querySelector('.offset-slider');
            const shiftSlider = elementDiv.querySelector('.shift-slider');
            const stretchSlider = elementDiv.querySelector('.stretch-slider');
            const durationSlider = elementDiv.querySelector('.duration-slider');
            
            offsetSlider.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                this.sequence.setOffset(parseInt(e.target.dataset.index), value);
                e.target.nextElementSibling.textContent = `${value}x`;
                this.updateSequencePlayback();
            });

            shiftSlider.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                this.sequence.setShift(parseInt(e.target.dataset.index), value);
                e.target.nextElementSibling.textContent = `${value} st`;
                this.updateSequencePlayback();
            });

            stretchSlider.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                this.sequence.setStretch(parseInt(e.target.dataset.index), value);
                e.target.nextElementSibling.textContent = `${value}x`;
                this.updateSequencePlayback();
            });

            durationSlider.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                this.sequence.setDuration(parseInt(e.target.dataset.index), value);
                e.target.nextElementSibling.textContent = `${value}x`;
                this.updateSequencePlayback();
            });

            elementDiv.querySelector('.remove-element').addEventListener('click', (e) => {
                const index = parseInt(e.target.dataset.index);
                const removedSound = this.sequence.elements[index].soundUrl;
                this.sequence.removeElement(index);
                
                // Find and remove highlight from the corresponding element if it's not used anymore
                if (!this.sequence.elements.some(el => el.soundUrl === removedSound)) {
                    this.shadowRoot.querySelector(`[data-sound="${removedSound}"]`)?.classList.remove('in-sequence');
                }
                
                this.updateSequenceElementsUI();
                this.updateSequencePlayback();
            });
            
            sequenceElements.appendChild(elementDiv);
        });
    }

    setMode(mode) {
        // Clear all looping voices when changing modes
        this.loopingVoices.clear();
        this.shadowRoot.querySelectorAll('.element').forEach(el => {
            el.classList.remove('looping');
        });
        this.updateAudioGraph();

        this.mode = mode;
    }
}

customElements.define('test-component', TestComponent);