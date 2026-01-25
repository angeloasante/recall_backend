# Reckall 🎬

> **"Shazam for Movies"** - Identify movies and TV shows by listening to audio or analyzing video clips.

![Platform](https://img.shields.io/badge/platform-iOS%20%7C%20Android-lightgrey)
![React Native](https://img.shields.io/badge/React%20Native-0.81.5-blue)
![Expo](https://img.shields.io/badge/Expo-SDK%2054-black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)

## ✨ Features

- **🎧 Audio Recognition** - Tap to listen and identify movies from dialogue
- **🎬 Video Upload** - Upload clips for deeper AI-powered analysis  
- **🏝️ Dynamic Island** - Live Activity shows recognition progress on iOS
- **⚙️ Control Center Widget** - Quick access button (iOS 18+)
- **🎭 Actor Recognition** - AI identifies actors in video frames
- **📝 Dialogue Matching** - Speech-to-text for quote identification
- **📊 History** - Track all your identified movies
- **🔍 Browse** - Trending, popular, and genre-based discovery

## 🛠 Tech Stack

### Frontend
| Technology | Purpose |
|------------|---------|
| React Native 0.81 | Cross-platform mobile |
| Expo SDK 54 | Development platform |
| TypeScript | Type safety |
| expo-av | Audio recording |
| Supabase | Realtime database |

### Backend
| Technology | Purpose |
|------------|---------|
| Next.js 14 | API server |
| Google Gemini 2.0 | AI recognition |
| OpenAI GPT-4V/Whisper | Fallback AI |
| FFmpeg | Audio/video processing |
| Supabase | PostgreSQL database |

### iOS Native
| Technology | Purpose |
|------------|---------|
| SwiftUI | Live Activity & Widget UI |
| ActivityKit | Dynamic Island |
| WidgetKit | Control Center Widget |

## 🚀 Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn
- Xcode 15+ (for iOS development)
- EAS CLI: `npm install -g eas-cli`

### Installation

1. **Clone and install dependencies:**
   ```bash
   cd movie-mvp
   npm install
   ```

2. **Set up environment variables:**
   ```bash
   # Create .env file
   EXPO_PUBLIC_API_URL=https://reckallbackend-production.up.railway.app
   EXPO_PUBLIC_SUPABASE_URL=your_supabase_url
   EXPO_PUBLIC_SUPABASE_ANON_KEY=your_supabase_key
   EXPO_PUBLIC_TMDB_API_KEY=your_tmdb_key
   ```

3. **Install iOS pods:**
   ```bash
   cd ios && pod install && cd ..
   ```

4. **Build development client:**
   ```bash
   eas build --profile development --platform ios
   ```

5. **Start the dev server:**
   ```bash
   npx expo start --dev-client --tunnel
   ```

### Backend Setup

```bash
cd backend
npm install

# Set environment variables
export GEMINI_API_KEY=xxx
export TMDB_API_KEY=xxx
export SUPABASE_URL=xxx
export SUPABASE_SERVICE_KEY=xxx

npm run dev
```

## 📁 Project Structure

```
reckall/
├── App.tsx                    # Main app with deep linking
├── api/
│   └── config.ts              # API configuration
├── components/
│   ├── TapToListenOverlay.tsx # Shazam-like UI
│   ├── MovieDetails.tsx       # Movie detail view
│   ├── SearchScreen.tsx       # Browse & search
│   └── ...
├── services/
│   ├── LiveActivityService.ts # iOS Live Activity bridge
│   ├── TMDBService.ts         # TMDB API client
│   └── UserService.ts         # User tracking
├── ios/
│   ├── Reckall/
│   │   └── ReckallLiveActivityModule.swift
│   └── ReckallWidget/
│       ├── ReckallLiveActivity.swift     # Dynamic Island
│       └── ReckallControlWidget.swift    # Control Center
└── backend/
    ├── app/api/
    │   ├── listen/            # Audio recognition
    │   ├── recognize-fast/    # Video recognition
    │   └── trending/          # Trending content
    └── lib/
        ├── gemini.ts          # AI integration
        └── tmdb.ts            # Movie database
```

## 🔗 Deep Linking

| URL | Action |
|-----|--------|
| `reckall://` | Open app |
| `reckall://listen` | Start listening mode |
| `reckall://movie/:id` | Open movie details |

## 📱 Recognition Pipelines

| Pipeline | Speed | Use Case |
|----------|-------|----------|
| `/api/listen` | ~10-15s | Audio-only (Control Center) |
| `/api/recognize-fast` | ~15-20s | General video recognition |
| `/api/recognize-v2` | ~40-120s | Complex clips |

## 🏗 Build Commands

```bash
# Development (physical device)
eas build --profile development --platform ios

# Development (simulator)  
eas build --profile development-simulator --platform ios

# Production
eas build --profile production --platform ios

# Deploy backend
cd backend && railway up
```

## 📚 Documentation

For detailed technical documentation, see:
- [Complete Codebase Documentation](docs/CODEBASE_DOCUMENTATION.md)
- [Recognition Pipeline Details](docs/RECOGNITION_PIPELINE.md)
- [Native Setup Guide](docs/NATIVE_SETUP_GUIDE.md)

## 🔧 Environment Variables

### Frontend (.env)
```
EXPO_PUBLIC_API_URL=https://reckallbackend-production.up.railway.app
EXPO_PUBLIC_SUPABASE_URL=xxx
EXPO_PUBLIC_SUPABASE_ANON_KEY=xxx
EXPO_PUBLIC_TMDB_API_KEY=xxx
```

### Backend
```
GEMINI_API_KEY=xxx
TMDB_API_KEY=xxx
SUPABASE_URL=xxx
SUPABASE_SERVICE_KEY=xxx
OPENAI_API_KEY=xxx  # Optional fallback
```

## 📄 License

Proprietary - Reckall © 2024

## Development

Edit `App.tsx` to start building your movie app. The app will automatically reload when you save changes.

## License
do you thingy
