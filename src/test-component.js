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
            0.5 // Output gain
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
            0.5 // Output gain
        );
    }

    updateAudioGraph() {
        if (this.mode === 'explore looping') {
            // For looping mode, sum all active looping voices
            if (this.loopingVoices.size > 0) {
                const voices = Array.from(this.loopingVoices.values());
                this.core.render(el.add(...voices));
            } else {
                this.core.render(el.const({value: 0})); // Silence
            }
        } else if (this.mode === 'explore one-off') {
            // For one-off mode, sum all active voices
            if (this.activeVoices.size > 0) {
                const voices = Array.from(this.activeVoices.values());
                this.core.render(voices.length === 1 ? voices[0] : el.add(...voices));
            } else {
                this.core.render(el.const({value: 0})); // Silence
            }
        }
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
            </style>
            <div class="container">
                <h1>Elementary Audio Test</h1>
                <button id="init-audio">Initialize Audio</button>
                <div class="mode-buttons">
                    <button id="mode-one-off">Explore One-Off</button>
                    <button id="mode-looping">Explore Looping</button>
                    <button id="mode-trajectory">Trajectory</button>
                    <button id="mode-sequence">Sequence</button>
                </div>
                <div id="current-mode">Current Mode: ${this.mode}</div>
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
        this.shadowRoot.querySelector('#mode-one-off').addEventListener('click', () => this.setMode('explore one-off'));
        this.shadowRoot.querySelector('#mode-looping').addEventListener('click', () => this.setMode('explore looping'));
        this.shadowRoot.querySelector('#mode-trajectory').addEventListener('click', () => this.setMode('trajectory'));
        this.shadowRoot.querySelector('#mode-sequence').addEventListener('click', () => this.setMode('sequence'));

        // Sound element event handlers
        this.shadowRoot.querySelectorAll('.element').forEach(element => {
            element.addEventListener('mouseenter', () => {
                if (this.mode === 'explore one-off') {
                    this.playOneOffSound(element);
                }
            });

            element.addEventListener('click', () => {
                if (this.mode === 'explore looping') {
                    this.toggleLoopingSound(element);
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
        this.shadowRoot.querySelector('#current-mode').textContent = `Current Mode: ${this.mode}`;
    }
}

customElements.define('test-component', TestComponent);