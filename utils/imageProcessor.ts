import { AntiAILevel } from '../types';

export const processAntiAI = (base64Image: string, level: AntiAILevel): Promise<string> => {
  if (level === 'off') return Promise.resolve(base64Image);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(base64Image);
        return;
      }

      let width = img.width;
      let height = img.height;
      let scale = 1;
      let offsetX = 0;
      let offsetY = 0;
      let noiseIntensity = 0;
      let jpegQuality = 0.95;
      let applyColorTint = false;

      if (level === 'low') {
        jpegQuality = 0.92;
      } else if (level === 'medium') {
        jpegQuality = 0.90;
        noiseIntensity = 0.03; // 3% noise
      } else if (level === 'high') {
        jpegQuality = 0.85;
        noiseIntensity = 0.05; // 5% noise
        scale = 1.01; // Scale up 1% to crop edges
        offsetX = -(width * 0.005);
        offsetY = -(height * 0.005);
        applyColorTint = true;
      }

      canvas.width = width;
      canvas.height = height;

      // Draw image with potential scaling/cropping
      ctx.drawImage(img, offsetX, offsetY, width * scale, height * scale);

      // Apply noise and color tint if needed
      if (noiseIntensity > 0 || applyColorTint) {
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;

        for (let i = 0; i < data.length; i += 4) {
          // Add noise
          if (noiseIntensity > 0) {
            const noise = (Math.random() - 0.5) * 255 * noiseIntensity;
            data[i] = Math.min(255, Math.max(0, data[i] + noise));     // R
            data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise)); // G
            data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise)); // B
          }

          // Apply slight warm vintage tint for 'high' level
          if (applyColorTint) {
            data[i] = Math.min(255, data[i] * 1.02);       // Slightly boost red
            data[i + 1] = Math.min(255, data[i + 1] * 1.01);   // Slightly boost green
            data[i + 2] = Math.min(255, data[i + 2] * 0.98);   // Slightly reduce blue
          }
        }
        ctx.putImageData(imageData, 0, 0);
      }

      // Export as JPEG to strip metadata and apply lossy compression
      const processedBase64 = canvas.toDataURL('image/jpeg', jpegQuality);
      resolve(processedBase64);
    };
    
    img.onerror = () => {
      console.error('Failed to process image for Anti-AI');
      resolve(base64Image); // Fallback to original if processing fails
    };
    
    img.src = base64Image;
  });
};
