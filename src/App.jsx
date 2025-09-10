import React from "react";
import CameraRecorder from "./CameraRecorder"; // Import the CameraRecorder component
import "./App.css"; // Your global CSS file

function App() {
  return (
    <div className="App">
      <h1>Camera Recorder App</h1>
      <CameraRecorder /> {/* Render CameraRecorder */}
    </div>
  );
}

export default App;
