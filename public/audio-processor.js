// AudioWorklet processor - remplace le ScriptProcessorNode déprécié
class PCMProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const input = inputs[0];
        if (input && input[0] && input[0].length > 0) {
            const float32 = input[0];
            const int16 = new Int16Array(float32.length);
            for (let i = 0; i < float32.length; i++) {
                int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
            }
            // Transfert du buffer sans copie pour la performance
            const buffer = int16.buffer.slice(0);
            this.port.postMessage(buffer, [buffer]);
        }
        return true; // Garde le processor actif
    }
}

registerProcessor('pcm-processor', PCMProcessor);
