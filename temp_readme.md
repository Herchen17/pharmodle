# Physiodle 🦴

A Wordle-style daily puzzle game for physiotherapy diagnosis. Guess the condition based on clinical clues!

## Features

- **Daily Puzzles**: One new puzzle per day (server-side time)
- **Clinical Matching**: 5-layer fuzzy matching engine recognizes equivalent diagnoses
- **Friends & Leaderboards**: Compete with friends across today, weekly, monthly, all-time, and global boards
- **Cross-Device**: Sign up with username/password, play from any device
- **Archive**: Play all past puzzles and track your history
- **Mobile-Friendly**: Fully responsive design for iPhones and all devices

## Tech Stack

- **Backend**: Node.js + Express
- **Database**: SQLite (better-sqlite3)
- **Auth**: JWT + bcryptjs
- **Frontend**: Vanilla JavaScript (single HTML file)
- **Matching Engine**: 100 clinical equivalence groups + parent term matching

## Quick Start

```bash
npm install
JWT_SECRET=your-secret-key npm start
```

Server runs on `http://localhost:3000`

## Deployment

Designed for Railway:
1. Push to GitHub
2. Connect to Railway
3. Set `JWT_SECRET` env var
4. Deploy!

## Game Rules

- **5 clinical clues** (reveal voluntarily or use wrong guesses)
- **5 attempts** to guess the correct diagnosis
- **Score**: 1 (first try) to 5 (fifth try)
- **Matching**: Fuzzy matching accepts equivalent diagnoses

## API Endpoints

### Auth
- `POST /api/auth/signup` - Create account
- `POST /api/auth/login` - Sign in
- `GET /api/auth/me` - User profile + stats

### Puzzles
- `GET /api/puzzle/today` - Today's puzzle
- `GET /api/puzzle/:dayNumber` - Past puzzle
- `GET /api/puzzle/conditions` - Autocomplete list
- `POST /api/puzzle/submit` - Submit answer
- `GET /api/puzzle/history/list` - Your completed puzzles

### Friends
- `POST /api/friends/request` - Send friend request
- `GET /api/friends/requests` - View pending requests
- `POST /api/friends/accept/:id` - Accept request
- `GET /api/friends` - List friends + their stats

### Leaderboards
- `GET /api/leaderboard/today` - Friends' scores today
- `GET /api/leaderboard/weekly` - Friends' scores this week
- `GET /api/leaderboard/monthly` - Friends' scores this month
- `GET /api/leaderboard/alltime` - Friends' all-time scores
- `GET /api/leaderboard/global` - Global top players

---

Built for medical students passionate about physiotherapy. Play daily, share with friends, compete for bragging rights! 🏆
