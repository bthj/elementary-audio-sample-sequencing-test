import {el} from '@elemaudio/core';
import WebRenderer from '@elemaudio/web-renderer';

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
            el.sample(
                { path: soundUrl, mode: 'trigger' },
                el.const({ key: `${voiceKey}-trigger`, value: 1 }),
                1
            ),
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
        setTimeout(() => {
            this.activeVoices.delete(voiceId);
            this.updateAudioGraph();
        }, duration * 1000);
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
                            <button id="clear-trajectory" disabled>Clear Trajectory</button>
                        </div>
                    </div>
                </div>

                <div id="content">
                    <div class="element" data-sound="https://ns9648k.web.sigma2.no/evoConf_singleMap_refSingleEmb_mfcc-sans0-statistics_pca_retrainIncr50_zScoreNSynthTrain_bassSynth/01JCVR4RSQNYCM6PFBZC0TZ0HD_evoConf_singleMap_refSingleEmb_mfcc-sans0-statistics_pca_retrainIncr50_zScoreNSynthTrain_bassSynth/01JCXDE8GYPBGY6579CNEVDESS-4_0_1.wav">Element 1</div>
                    <div class="element" data-sound="https://ns9648k.web.sigma2.no/evoConf_singleMap_refSingleEmb_mfcc-sans0-statistics_pca_retrainIncr50_zScoreNSynthTrain_bassSynth/01JCVR4RSQNYCM6PFBZC0TZ0HD_evoConf_singleMap_refSingleEmb_mfcc-sans0-statistics_pca_retrainIncr50_zScoreNSynthTrain_bassSynth/01JCXC5834FMVTRV3C6PZ1MH4E-4_0_1.wav">Element 2</div>
                    <div class="element" data-sound="https://ns9648k.web.sigma2.no/evoConf_singleMap_refSingleEmb_mfcc-sans0-statistics_pca_retrainIncr50_zScoreNSynthTrain_bassSynth/01JCVR4RSQNYCM6PFBZC0TZ0HD_evoConf_singleMap_refSingleEmb_mfcc-sans0-statistics_pca_retrainIncr50_zScoreNSynthTrain_bassSynth/01JCX1R8B6A9QSMPEJ7D1C2WY1-4_0_1.wav">Element 3</div>
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
        const clearButton = this.shadowRoot.querySelector('#clear-trajectory');

        recordButton.addEventListener('click', () => {
            this.startTrajectoryRecording();
            recordButton.disabled = true;
            stopButton.disabled = false;
            clearButton.disabled = true;
            this.shadowRoot.querySelectorAll('.element').forEach(el => 
                el.classList.add('recording'));
        });

        stopButton.addEventListener('click', () => {
            this.stopTrajectoryRecording();
            recordButton.disabled = false;
            stopButton.disabled = true;
            clearButton.disabled = false;
            this.shadowRoot.querySelectorAll('.element').forEach(el => 
                el.classList.remove('recording'));
        });

        clearButton.addEventListener('click', () => {
            this.clearTrajectory();
            clearButton.disabled = true;
        });

        // Sound element event handlers
        this.shadowRoot.querySelectorAll('.element').forEach(element => {
            // Handler for hover interactions
            element.addEventListener('mouseenter', () => {
                if (!this.initialized) return;

                if (this.isRecording) {
                    this.recordEvent(element);
                }

                if (this.interactionMode === 'hover' && !this.isPlayingTrajectory) {
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

                if (this.isRecording) {
                    this.recordEvent(element);
                }

                if (this.interactionMode === 'click' && !this.isPlayingTrajectory) {
                    if (this.mode === 'explore one-off') {
                        this.playOneOffSound(element);
                    } else if (this.mode === 'explore looping') {
                        this.toggleLoopingSound(element);
                    }
                }
            });
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

    startTrajectoryRecording() {
        this.isRecording = true;
        this.trajectoryEvents = [];
        this.recordingStartTime = null;
        console.log('Started recording trajectory');
    }

    stopTrajectoryRecording() {
        this.isRecording = false;
        console.log('Stopped recording trajectory. Events:', this.trajectoryEvents);
        if (this.trajectoryEvents.length > 0) {
            this.playTrajectory();
        }
    }

    clearTrajectory() {
        this.trajectoryEvents = [];
        this.isPlayingTrajectory = false;
        this.updateAudioGraph(); // Reset to silence
        console.log('Cleared trajectory');
    }

    recordEvent(element) {
        const soundUrl = element.getAttribute('data-sound');
        const currentTime = this.recordingStartTime === null ? 
            0 : (Date.now() - this.recordingStartTime) / 1000; // Convert to seconds

        if (this.recordingStartTime === null) {
            this.recordingStartTime = Date.now();
        }

        this.trajectoryEvents.push({
            time: currentTime,
            soundUrl: soundUrl
        });
        console.log('Recorded event:', { time: currentTime, soundUrl });
    }

    async playTrajectory() {
      if (this.trajectoryEvents.length === 0) return;
      
      this.isPlayingTrajectory = true;
      
      // First ensure all samples are loaded
      const uniqueSounds = [...new Set(this.trajectoryEvents.map(evt => evt.soundUrl))];
      for (const soundUrl of uniqueSounds) {
          if (!this.uploadedSamples.has(soundUrl)) {
              const res = await fetch(soundUrl);
              const sampleBuffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
              
              await this.core.updateVirtualFileSystem({
                  [soundUrl]: [sampleBuffer.getChannelData(0)]
              });
              
              this.uploadedSamples.add(soundUrl);
              this.sampleDurations.set(soundUrl, sampleBuffer.duration);
          }
      }
  
      // Create timing signal - must be an Elementary node
      const ticker = el.train(100);  // 100Hz clock
  
      // Format and log sequence data
      const seq = this.trajectoryEvents.map(evt => ({
          tickTime: Math.round(evt.time * 100), // Convert to ticks at 100Hz
          value: uniqueSounds.indexOf(evt.soundUrl) // Use sound index as value
      }));
      console.log('Sequence data:', seq);
  
      // Calculate loop points considering sample durations
      const firstTick = seq[0].tickTime;
      const lastTick = seq[seq.length - 1].tickTime;
  
      // For each event, calculate when its sample finishes playing
      const endPoints = seq.map(event => {
          const soundUrl = uniqueSounds[event.value];
          const sampleDuration = this.sampleDurations.get(soundUrl);
          // Convert sample duration to ticks (sample duration is in seconds)
          const durationInTicks = Math.ceil(sampleDuration * 100); // 100Hz tick rate
          return event.tickTime + durationInTicks;
      });
  
      // Find the latest endpoint
      const latestEndpoint = Math.max(...endPoints);
      
      // Create master sequence with loop points
      const sequence = el.sparseq({
          seq: seq,
          loop: [firstTick, latestEndpoint]
      }, ticker, el.const({value: 0}));
  
      console.log('Created sequence node:', sequence);
  
      // Debug sequence
      console.log('Sequence:', sequence);
  
      // Create a player for each sound
      const players = uniqueSounds.map((soundUrl, index) => {
          console.log(`Creating player for sound ${index}:`, soundUrl);
  
          // Compare sequence value to this sound's index
          const trigger = el.eq(sequence, el.const({value: index}));
          console.log('Trigger node for index', index, ':', trigger);
          
          const player = el.sample({
              path: soundUrl,
              mode: 'trigger'
          }, trigger, el.const({value: 1}));
          console.log('Player node for index', index, ':', player);
  
          return player;
      });
  
      console.log('All players:', players);
  
      // Mix all players with equal gain - try with explicit node creation
      let signal;
      if (players.length === 1) {
          signal = el.mul(players[0], el.const({value: 1 / this.maxVoices}));
      } else {
          const mixed = el.add(...players);
          console.log('Mixed signal:', mixed);
          signal = el.mul(mixed, el.const({value: 1 / this.maxVoices}));
      }
  
      console.log('Final signal:', signal);
  
      // Render the mixed signal to both channels
      this.core.render(signal, signal);
      
      console.log('Playing trajectory:', {
          uniqueSounds,
          sampleDurations: Object.fromEntries([...this.sampleDurations])
      });
  }
}

customElements.define('test-component', TestComponent);