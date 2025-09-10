import React, { useState, useRef, useEffect, useCallback } from "react";

// Web Worker for video processing (inline for simplicity)
const createVideoWorker = () => {
  const workerCode = `
    self.onmessage = function(e) {
      const { imageData, filters, width, height } = e.data;
      
      // Apply filters to image data
      const data = imageData.data;
      
      if (filters.brightness !== 100) {
        const factor = filters.brightness / 100;
        for (let i = 0; i < data.length; i += 4) {
          data[i] = Math.min(255, data[i] * factor);     // Red
          data[i + 1] = Math.min(255, data[i + 1] * factor); // Green
          data[i + 2] = Math.min(255, data[i + 2] * factor); // Blue
        }
      }
      
      if (filters.contrast !== 100) {
        const factor = (259 * (filters.contrast + 255)) / (255 * (259 - filters.contrast));
        for (let i = 0; i < data.length; i += 4) {
          data[i] = Math.max(0, Math.min(255, factor * (data[i] - 128) + 128));
          data[i + 1] = Math.max(0, Math.min(255, factor * (data[i + 1] - 128) + 128));
          data[i + 2] = Math.max(0, Math.min(255, factor * (data[i + 2] - 128) + 128));
        }
      }
      
      if (filters.saturation !== 100) {
        const factor = filters.saturation / 100;
        for (let i = 0; i < data.length; i += 4) {
          const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          data[i] = gray + factor * (data[i] - gray);
          data[i + 1] = gray + factor * (data[i + 1] - gray);
          data[i + 2] = gray + factor * (data[i + 2] - gray);
        }
      }
      
      self.postMessage({ imageData, processed: true });
    };
  `;

  const blob = new Blob([workerCode], { type: "application/javascript" });
  return new Worker(URL.createObjectURL(blob));
};

// Memory management utilities
const memoryManager = {
  chunks: new Set(),
  urls: new Set(),

  addChunk(chunk) {
    this.chunks.add(chunk);
  },

  addUrl(url) {
    this.urls.add(url);
  },

  cleanup() {
    this.urls.forEach((url) => {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {
        console.warn("Failed to revoke URL:", e);
      }
    });
    this.urls.clear();
    this.chunks.clear();

    // Force garbage collection if available
    if (window.gc) {
      window.gc();
    }
  },
};

const CameraRecorder = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [videoUrl, setVideoUrl] = useState(null);
  const [facingMode, setFacingMode] = useState("user");
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [filter, setFilter] = useState("none");
  const [mirror, setMirror] = useState(false);
  const [crop, setCrop] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [recordingTime, setRecordingTime] = useState(0);
  const [videoQuality, setVideoQuality] = useState("1080p");
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [saturation, setSaturation] = useState(100);
  const [videoSize, setVideoSize] = useState(null);

  const mediaRecorderRef = useRef(null);
  const videoStreamRef = useRef(null);
  const recordedChunks = useRef([]);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const ctxRef = useRef(null);
  const animationFrameRef = useRef(null);
  const recordingIntervalRef = useRef(null);
  const videoWorkerRef = useRef(null);
  const offscreenCanvasRef = useRef(null);
  const performanceMonitorRef = useRef({ frameCount: 0, lastTime: 0, fps: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      ctxRef.current = canvas.getContext("2d", {
        alpha: false,
        desynchronized: true, // Better performance
        willReadFrequently: false,
      });
    }

    // Initialize Web Worker for heavy processing
    videoWorkerRef.current = createVideoWorker();

    // Create offscreen canvas for better performance
    if (window.OffscreenCanvas) {
      offscreenCanvasRef.current = new OffscreenCanvas(800, 600);
    }

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
      }
      if (videoWorkerRef.current) {
        videoWorkerRef.current.terminate();
      }
      memoryManager.cleanup();
    };
  }, []);

  // Performance monitoring
  const updatePerformanceMetrics = useCallback(() => {
    const now = performance.now();
    const monitor = performanceMonitorRef.current;

    monitor.frameCount++;

    if (now - monitor.lastTime >= 1000) {
      monitor.fps = Math.round(
        (monitor.frameCount * 1000) / (now - monitor.lastTime)
      );
      monitor.frameCount = 0;
      monitor.lastTime = now;

      // Log performance warnings
      if (monitor.fps < 15) {
        console.warn(`Low FPS detected: ${monitor.fps}fps`);
      }
    }
  }, []);

  // Optimized memory usage for chunks
  const addRecordedChunk = useCallback((chunk) => {
    recordedChunks.current.push(chunk);
    memoryManager.addChunk(chunk);

    // Limit memory usage by clearing old chunks if too many
    if (recordedChunks.current.length > 1000) {
      const oldChunks = recordedChunks.current.splice(0, 500);
      oldChunks.forEach((chunk) => {
        memoryManager.chunks.delete(chunk);
      });
    }
  }, []);

  const getVideoConstraints = useCallback(() => {
    const constraints = {
      facingMode,
      width: {
        ideal:
          videoQuality === "1080p"
            ? 1920
            : videoQuality === "720p"
            ? 1280
            : 640,
      },
      height: {
        ideal:
          videoQuality === "1080p" ? 1080 : videoQuality === "720p" ? 720 : 480,
      },
      frameRate: { ideal: 30, max: 60 },
    };
    return constraints;
  }, [facingMode, videoQuality]);

  const applyFilters = useCallback(() => {
    let filterString = "";

    if (filter !== "none") {
      filterString += filter + " ";
    }

    if (brightness !== 100) {
      filterString += `brightness(${brightness}%) `;
    }

    if (contrast !== 100) {
      filterString += `contrast(${contrast}%) `;
    }

    if (saturation !== 100) {
      filterString += `saturate(${saturation}%) `;
    }

    return filterString.trim() || "none";
  }, [filter, brightness, contrast, saturation]);

  const formatTime = useCallback((seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  }, []);

  const formatFileSize = useCallback((bytes) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }, []);

  const startPreview = async () => {
    try {
      setIsLoading(true);
      setError(null);

      const stream = await navigator.mediaDevices.getUserMedia({
        video: getVideoConstraints(),
        audio: true,
      });

      videoStreamRef.current = stream;
      videoRef.current.srcObject = stream;
      setIsPreviewing(true);

      const video = videoRef.current;
      await video.play();

      const draw = () => {
        if (!video.videoWidth || !video.videoHeight) {
          animationFrameRef.current = requestAnimationFrame(draw);
          return;
        }

        updatePerformanceMetrics();

        const width = video.videoWidth;
        const height = video.videoHeight;
        const canvas = canvasRef.current;

        // Optimize canvas size changes
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }

        const ctx = ctxRef.current;

        // Use offscreen canvas for heavy processing if available
        let targetCanvas = canvas;
        let targetCtx = ctx;

        if (
          offscreenCanvasRef.current &&
          (brightness !== 100 || contrast !== 100 || saturation !== 100)
        ) {
          const offscreen = offscreenCanvasRef.current;
          if (offscreen.width !== width || offscreen.height !== height) {
            offscreen.width = width;
            offscreen.height = height;
          }
          targetCanvas = offscreen;
          targetCtx = offscreen.getContext("2d");
        }

        targetCtx.clearRect(0, 0, width, height);

        // Apply CSS filters for better performance
        targetCtx.filter = applyFilters();
        targetCtx.save();

        if (mirror) {
          targetCtx.scale(-1, 1);
          targetCtx.translate(-width, 0);
        }

        targetCtx.drawImage(video, 0, 0, width, height);
        targetCtx.restore();

        // Copy from offscreen to main canvas if used
        if (targetCanvas !== canvas) {
          ctx.clearRect(0, 0, width, height);
          ctx.drawImage(targetCanvas, 0, 0);
        }

        if (isPreviewing) {
          // Throttle frame rate for better performance
          const targetFPS = 30;
          const delay = 1000 / targetFPS;
          setTimeout(() => {
            animationFrameRef.current = requestAnimationFrame(draw);
          }, delay);
        }
      };

      video.addEventListener("loadedmetadata", () => {
        draw();
      });
    } catch (err) {
      console.error("Error starting preview:", err);

      // If permission was denied, try to request permissions again
      if (
        err.name === "NotAllowedError" ||
        err.name === "PermissionDeniedError"
      ) {
        try {
          // Request permissions explicitly
          const permissions = await navigator.permissions.query({
            name: "camera",
          });
          const micPermissions = await navigator.permissions.query({
            name: "microphone",
          });

          if (
            permissions.state === "denied" ||
            micPermissions.state === "denied"
          ) {
            setError(
              "Camera and microphone access is required. Please enable permissions in your browser settings and try again."
            );
          } else {
            // Try to request media again after a short delay
            setTimeout(async () => {
              try {
                const stream = await navigator.mediaDevices.getUserMedia({
                  video: getVideoConstraints(),
                  audio: true,
                });

                videoStreamRef.current = stream;
                videoRef.current.srcObject = stream;
                setIsPreviewing(true);
                setError(null);

                const video = videoRef.current;
                await video.play();

                // Start the drawing loop
                const draw = () => {
                  if (!video.videoWidth || !video.videoHeight) {
                    animationFrameRef.current = requestAnimationFrame(draw);
                    return;
                  }

                  updatePerformanceMetrics();

                  const width = video.videoWidth;
                  const height = video.videoHeight;
                  const canvas = canvasRef.current;

                  if (canvas.width !== width || canvas.height !== height) {
                    canvas.width = width;
                    canvas.height = height;
                  }

                  const ctx = ctxRef.current;
                  let targetCanvas = canvas;
                  let targetCtx = ctx;

                  if (
                    offscreenCanvasRef.current &&
                    (brightness !== 100 ||
                      contrast !== 100 ||
                      saturation !== 100)
                  ) {
                    const offscreen = offscreenCanvasRef.current;
                    if (
                      offscreen.width !== width ||
                      offscreen.height !== height
                    ) {
                      offscreen.width = width;
                      offscreen.height = height;
                    }
                    targetCanvas = offscreen;
                    targetCtx = offscreen.getContext("2d");
                  }

                  targetCtx.clearRect(0, 0, width, height);
                  targetCtx.filter = applyFilters();
                  targetCtx.save();

                  if (mirror) {
                    targetCtx.scale(-1, 1);
                    targetCtx.translate(-width, 0);
                  }

                  targetCtx.drawImage(video, 0, 0, width, height);
                  targetCtx.restore();

                  if (targetCanvas !== canvas) {
                    ctx.clearRect(0, 0, width, height);
                    ctx.drawImage(targetCanvas, 0, 0);
                  }

                  if (isPreviewing) {
                    const targetFPS = 30;
                    const delay = 1000 / targetFPS;
                    setTimeout(() => {
                      animationFrameRef.current = requestAnimationFrame(draw);
                    }, delay);
                  }
                };

                video.addEventListener("loadedmetadata", () => {
                  draw();
                });
              } catch (retryErr) {
                console.error("Retry failed:", retryErr);
                setError(
                  `Please grant camera and microphone permissions and try again. Error: ${retryErr.message}`
                );
              }
            }, 1000);
          }
        } catch (permErr) {
          console.error("Permission check failed:", permErr);
          setError(
            "Unable to check permissions. Please ensure camera and microphone access is allowed and try again."
          );
        }
      } else {
        setError(`Failed to start preview: ${err.message}`);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const stopPreview = () => {
    if (videoStreamRef.current) {
      videoStreamRef.current.getTracks().forEach((track) => track.stop());
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    setIsPreviewing(false);
  };

  const startRecording = async () => {
    try {
      setIsLoading(true);
      setError(null);
      setRecordingTime(0);

      let stream;
      if (isPreviewing && videoStreamRef.current) {
        stream = videoStreamRef.current;
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          video: getVideoConstraints(),
          audio: true,
        });
        videoStreamRef.current = stream;
      }

      const options = {
        mimeType: "video/webm;codecs=vp9,opus",
        videoBitsPerSecond:
          videoQuality === "1080p"
            ? 5000000
            : videoQuality === "720p"
            ? 2500000
            : 1000000,
      };

      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options.mimeType = "video/webm";
      }

      mediaRecorderRef.current = new MediaRecorder(stream, options);
      recordedChunks.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          addRecordedChunk(event.data);
        }
      };

      mediaRecorderRef.current.onstop = async () => {
        try {
          const blob = new Blob(recordedChunks.current, { type: "video/webm" });
          const url = URL.createObjectURL(blob);
          memoryManager.addUrl(url);
          setVideoUrl(url);
          setVideoSize(blob.size);

          // Clear chunks after creating blob
          recordedChunks.current = [];

          // Force garbage collection
          if (window.gc) {
            setTimeout(() => window.gc(), 1000);
          }
        } catch (err) {
          setError(`Failed to process recording: ${err.message}`);
        }
      };

      mediaRecorderRef.current.start(1000); // Collect data every second
      setIsRecording(true);

      // Start recording timer
      recordingIntervalRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      console.error("Error starting recording:", err);
      setError(`Failed to start recording: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const stopRecording = () => {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state === "recording"
    ) {
      mediaRecorderRef.current.stop();
    }

    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
    }

    if (!isPreviewing && videoStreamRef.current) {
      videoStreamRef.current.getTracks().forEach((track) => track.stop());
    }

    setIsRecording(false);
  };

  const downloadVideo = async () => {
    if (!videoUrl) return;

    try {
      setIsLoading(true);
      const a = document.createElement("a");
      a.href = videoUrl;
      a.download = `recording-${Date.now()}.webm`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      setError(`Download failed: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const switchCamera = async () => {
    const newFacingMode = facingMode === "user" ? "environment" : "user";
    setFacingMode(newFacingMode);

    if (isPreviewing) {
      stopPreview();
      // Small delay to ensure cleanup
      setTimeout(() => {
        startPreview();
      }, 100);
    }
  };

  // const resetFilters = () => {
  //   setFilter("none");
  //   setBrightness(100);
  //   setContrast(100);
  //   setSaturation(100);
  //   setMirror(false);
  //   setCrop(false);
  // };

  return (
    <div className="camera-recorder">
      {error && (
        <div
          className="error-message"
          style={{
            background: "rgba(255, 107, 107, 0.2)",
            border: "1px solid rgba(255, 107, 107, 0.5)",
            borderRadius: "8px",
            padding: "1rem",
            marginBottom: "1rem",
            color: "#ff6b6b",
          }}
        >
          {error}
        </div>
      )}

      <div className="video-container">
        {isRecording && (
          <div className="recording-timer">
            🔴 REC {formatTime(recordingTime)}
          </div>
        )}

        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="video-preview"
          style={{
            display: isPreviewing ? "block" : "none",
            marginBottom: "1rem",
            width: "800px",
            height: "500px",
            objectFit: "cover",
          }}
        />

        {!isPreviewing && !isRecording && (
          <div
            style={{
              position: "relative",
              margin: "1rem",
              // color: "rgba(255,255,255,0.7)",
              fontSize: "1.2rem",
              textAlign: "center",
            }}
          >
            📹 Click "Start Preview" to begin
          </div>
        )}
      </div>

      <div className="controls">
        {!isPreviewing && !isRecording && (
          <button onClick={startPreview} disabled={isLoading}>
            {isLoading ? "⏳ Loading..." : "📹 Start Preview"}
          </button>
        )}
        {isPreviewing && !isRecording && (
          <button onClick={stopPreview}>⏹️ Stop Preview</button>
        )}

        {isRecording ? (
          <button onClick={stopRecording} className="recording">
            ⏹️ Stop Recording
          </button>
        ) : (
          <button onClick={startRecording} disabled={isLoading}>
            {isLoading ? "⏳ Starting..." : "🔴 Start Recording"}
          </button>
        )}

        <button onClick={switchCamera} disabled={isRecording || isLoading}>
          🔄 Switch Camera
        </button>

        {/* <button onClick={resetFilters} disabled={isLoading}>
          🔄 Reset Filters
        </button> */}
      </div>

      {/* <div className="settings">
        <div className="setting-group">
          <label>Video Quality:</label>
          <select
            value={videoQuality}
            onChange={(e) => setVideoQuality(e.target.value)}
            disabled={isRecording}
          >
            <option value="480p">480p (SD)</option>
            <option value="720p">720p (HD)</option>
            <option value="1080p">1080p (Full HD)</option>
          </select>
        </div>

        <div className="setting-group">
          <label>Filter Effects:</label>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="none">None</option>
            <option value="grayscale(100%)">Grayscale</option>
            <option value="sepia(100%)">Sepia</option>
            <option value="invert(100%)">Invert</option>
            <option value="blur(2px)">Blur</option>
            <option value="hue-rotate(90deg)">Hue Rotate</option>
          </select>
        </div>

        <div className="setting-group">
          <label>Brightness: {brightness}%</label>
          <input
            type="range"
            min="50"
            max="200"
            value={brightness}
            onChange={(e) => setBrightness(Number(e.target.value))}
          />
        </div>

        <div className="setting-group">
          <label>Contrast: {contrast}%</label>
          <input
            type="range"
            min="50"
            max="200"
            value={contrast}
            onChange={(e) => setContrast(Number(e.target.value))}
          />
        </div>

        <div className="setting-group">
          <label>Saturation: {saturation}%</label>
          <input
            type="range"
            min="0"
            max="200"
            value={saturation}
            onChange={(e) => setSaturation(Number(e.target.value))}
          />
        </div>

        <div className="setting-group">
          <div className="checkbox-wrapper">
            <input
              type="checkbox"
              id="mirror"
              checked={mirror}
              onChange={() => setMirror(!mirror)}
            />
            <label htmlFor="mirror">Mirror Video</label>
          </div>

          <div className="checkbox-wrapper">
            <input
              type="checkbox"
              id="crop"
              checked={crop}
              onChange={() => setCrop(!crop)}
            />
            <label htmlFor="crop">Crop Video</label>
          </div>
        </div>
      </div> */}

      {videoUrl && (
        <div className="recorded-video">
          <h2>📹 Recorded Video</h2>
          <video
            src={videoUrl}
            controls
            playsInline
            style={{
              // display: isPreviewing ? "block" : "none",
              marginBottom: "1rem",
              width: "800px",
              height: "500px",
              objectFit: "cover",
            }}
          />

          {videoSize && (
            <div className="video-info">
              <span>Duration: {formatTime(recordingTime)}</span>
              <br />
              <span>Size: {formatFileSize(videoSize)}</span>
              <br />
              <span>Quality: {videoQuality}</span>
            </div>
          )}

          <div className="download-section">
            <button
              onClick={downloadVideo}
              disabled={isLoading}
              style={{
                padding: "12px 24px",
                fontSize: "16px",
                fontWeight: "600",
                borderRadius: "12px",
                border: "none",
                background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
                color: "white",
                cursor: isLoading ? "not-allowed" : "pointer",
                transition: "all 0.3s ease",
                boxShadow: "0 4px 15px rgba(102, 126, 234, 0.4)",
                opacity: isLoading ? 0.7 : 1,
              }}
            >
              {isLoading ? "⏳ Preparing..." : "📥 Download Video"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default CameraRecorder;
