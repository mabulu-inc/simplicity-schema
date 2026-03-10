import { execSync } from 'node:child_process';

export default function globalSetup() {
  execSync('docker compose up -d --wait', { stdio: 'inherit' });
}
