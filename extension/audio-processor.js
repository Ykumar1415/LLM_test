class PCMProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const opts = options.processorOptions || {};
        this.outputBufferSize = opts.bufferSize || 2048;
        this.inputRate = opts.inputSampleRate || 48000;
        this.outputRate = opts.outputSampleRate || 16000;
        this.ratio = this.inputRate / this.outputRate;
        this.needsResample = Math.abs(this.ratio - 1.0) > 0.01;
        this.buffer = new Float32Array(this.outputBufferSize);
        this.writeIndex = 0;
        this.resampleAccum = 0;
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || input.length === 0) return true;

        const channelData = input[0];
        if (!channelData) return true;

        const output = outputs[0];
        if (output && output.length > 0) {
            for (let ch = 0; ch < output.length; ch++) {
                if (input[ch]) {
                    output[ch].set(input[ch]);
                }
            }
        }

        if (this.needsResample) {
            for (let i = 0; i < channelData.length; i++) {
                this.resampleAccum += 1;
                if (this.resampleAccum >= this.ratio) {
                    this.resampleAccum -= this.ratio;
                    this.buffer[this.writeIndex++] = channelData[i];
                    if (this.writeIndex >= this.outputBufferSize) {
                        this.port.postMessage(this.buffer.slice());
                        this.writeIndex = 0;
                    }
                }
            }
        } else {
            for (let i = 0; i < channelData.length; i++) {
                this.buffer[this.writeIndex++] = channelData[i];
                if (this.writeIndex >= this.outputBufferSize) {
                    this.port.postMessage(this.buffer.slice());
                    this.writeIndex = 0;
                }
            }
        }

        return true;
    }
}

registerProcessor("pcm-processor", PCMProcessor);
