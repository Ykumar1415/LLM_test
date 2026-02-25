/**
 * Meet Live Translator — AudioWorklet Processor
 *
 * Runs on the audio rendering thread.
 * Collects PCM frames into buffers of configurable size,
 * then posts them to the main thread for WebSocket transmission.
 */

class PCMProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.bufferSize = options.processorOptions?.bufferSize || 2048;
        this.buffer = new Float32Array(this.bufferSize);
        this.writeIndex = 0;
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || input.length === 0) return true;

        // Take first channel (mono)
        const channelData = input[0];
        if (!channelData) return true;

        // Also pass through to output so user can still hear Meet audio
        const output = outputs[0];
        if (output && output.length > 0) {
            for (let ch = 0; ch < output.length; ch++) {
                if (input[ch]) {
                    output[ch].set(input[ch]);
                }
            }
        }

        // Accumulate samples into our buffer
        for (let i = 0; i < channelData.length; i++) {
            this.buffer[this.writeIndex++] = channelData[i];

            if (this.writeIndex >= this.bufferSize) {
                // Buffer full — post a copy to main thread
                this.port.postMessage(this.buffer.slice());
                this.writeIndex = 0;
            }
        }

        return true; // keep processor alive
    }
}

registerProcessor("pcm-processor", PCMProcessor);
