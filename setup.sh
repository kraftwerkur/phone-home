#!/usr/bin/env bash
set -e

echo "📡 Phone Home — Setup"
echo ""

# 1. Generate self-signed certs
CERT_DIR="hub/certs"
if [ -f "$CERT_DIR/key.pem" ]; then
  echo "✅ Certs already exist in $CERT_DIR/"
else
  echo "🔒 Generating self-signed certificate..."
  mkdir -p "$CERT_DIR"
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$CERT_DIR/key.pem" \
    -out "$CERT_DIR/cert.pem" \
    -days 365 \
    -subj "/CN=PhoneHome" \
    2>/dev/null

  # DER format for iOS cert install
  openssl x509 -in "$CERT_DIR/cert.pem" -outform der -out "$CERT_DIR/cert.der"
  echo "✅ Certs generated in $CERT_DIR/"
fi

# 2. Create .env from example
if [ -f ".env" ]; then
  echo "✅ .env already exists"
else
  cp .env.example .env
  echo "✅ Created .env from .env.example — edit it to configure Telegram alerts"
fi

# 3. Install Node dependencies
echo "📦 Installing Node.js dependencies..."
cd hub && npm install && cd ..

# 4. Set up Python venv for YOLO
if [ -d "venv" ]; then
  echo "✅ Python venv already exists"
else
  echo "🐍 Creating Python venv..."
  python3 -m venv venv
  echo "📦 Installing Python dependencies..."
  venv/bin/pip install ultralytics --quiet
fi

# 5. Ensure data dirs
mkdir -p data/snapshots data/audio data/clips data/alerts

echo ""
echo "🚀 Setup complete! Start the server with:"
echo "   cd hub && npm start"
echo ""
echo "Then open https://<your-lan-ip>:3900 in Safari on your iPhones."
