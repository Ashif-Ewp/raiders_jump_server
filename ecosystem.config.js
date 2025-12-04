module.exports = {
  apps: [
    {
      name: "my-app",
      script: "server.js",
      instances: 1, // or "max"
      autorestart: true,
      watch: false,
      max_memory_restart: "1G", // auto restart if memory > 1GB
      error_file: "./logs/error.log",
      out_file: "./logs/out.log",
      time: true,
    },
  ],
};
