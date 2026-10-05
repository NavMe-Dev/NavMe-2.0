import Module from 'module';
const originalLoad = Module.prototype.require;

// Intercept rollup native module loading
Module.prototype.require = function(id) {
  if (id.includes('rollup-linux-arm64')) {
    return { version: '4.23.1' };
  }
  return originalLoad.call(this, id);
};

// Import vite's bin script
import('./node_modules/vite/bin/vite.js');
