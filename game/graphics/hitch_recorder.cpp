#include "hitch_recorder.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <vector>

#include "fmt/format.h"

namespace hitch {
namespace {

constexpr int kPhaseCount = static_cast<int>(Phase::Count);
constexpr double kStatPeriodSeconds = 10.0;
constexpr size_t kStatCapacity = 32768;  // frames kept for the percentile: 10 s at up to ~3000 fps
constexpr double kDefaultHitchMs = 20.0;

s64 now_ns() {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

double ms(s64 ns) {
  return static_cast<double>(ns) / 1.0e6;
}

void store_max(std::atomic<s64>& slot, s64 value) {
  s64 seen = slot.load(std::memory_order_relaxed);
  while (value > seen && !slot.compare_exchange_weak(seen, value, std::memory_order_relaxed)) {
  }
}

/*! The game thread's per-frame worst case of each thing it measures, drained by the display thread
 *  once a frame. The two threads are not in lock step, so a game_* figure is the game thread's
 *  latest word as of this display frame, not a measure of the same frame number. */
struct GameSide {
  std::atomic<s64> compute_ns{0};          // from the last vsync returning to the next sync-path call
  std::atomic<s64> sync_path_wait_ns{0};   // blocked in sync-path: the renderer still had the last chain
  std::atomic<s64> vsync_wait_ns{0};       // blocked in vsync: waiting for the display thread's swap
  std::atomic<s64> send_chain_ns{0};       // handing the chain over (the DMA copy, the lock)
  std::atomic<s64> vsync_returned_at_ns{0};
};

/*! The same figures once drained, in ms, for the line being written. */
struct DrainedGame {
  double compute_ms = 0, sync_path_wait_ms = 0, vsync_wait_ms = 0, send_chain_ms = 0;
};

struct Recorder {
  Recorder() {
    if (const char* env = std::getenv("JAK_HITCH_MS")) {
      char* end = nullptr;
      const double parsed = std::strtod(env, &end);
      if (end != env && parsed > 0.0) {
        threshold_ms = parsed;
      }
    }
    frame_times_ms.reserve(kStatCapacity);
  }

  double threshold_ms = kDefaultHitchMs;
  GameSide game;
  DrainedGame drained;
  std::atomic<u32> hitches{0};

  // display thread only from here
  s64 cursor_ns = 0;  // where the phase in progress began
  std::array<s64, kPhaseCount> phase_ns{};
  s64 limiter_oversleep_ns = 0;
  bool no_chain_this_frame = false;
  u64 frame_number = 0;

  // the 10 s window
  s64 window_started_ns = 0;
  std::vector<float> frame_times_ms;
  u64 window_frames = 0;
  u64 window_over = 0;
  u64 window_no_chain = 0;
  double window_sum_ms = 0;
  double window_max_ms = 0;
};

Recorder g_rec;

const char* phase_name(int p) {
  static const char* names[kPhaseCount] = {"input_ms",   "wait_for_game_ms", "render_ms", "gui_ms",
                                           "limiter_ms", "swap_present_ms",  "post_ms"};
  return names[p];
}

void log_hitch(double frame_ms, bool no_chain, double oversleep_ms) {
  Recorder& r = g_rec;
  const u32 seq = r.hitches.fetch_add(1, std::memory_order_relaxed) + 1;
  std::string body = fmt::format("seq={} frame={} frame_ms={:.1f}", seq, r.frame_number, frame_ms);
  for (int p = 0; p < kPhaseCount; p++) {
    body += fmt::format(" {}={:.1f}", phase_name(p), ms(r.phase_ns[p]));
    if (p == static_cast<int>(Phase::Limiter)) {
      body += fmt::format(" limiter_oversleep_ms={:.1f}", oversleep_ms);
    }
  }
  body += no_chain ? " got_chain=no" : " got_chain=yes";
  // The game thread's side of the same stretch, drained by frame_end() before this call.
  body += fmt::format(
      " | game_compute_ms={:.1f} game_blocked_sync_path_ms={:.1f} game_blocked_vsync_ms={:.1f} "
      "game_send_chain_ms={:.1f}",
      r.drained.compute_ms, r.drained.sync_path_wait_ms, r.drained.vsync_wait_ms,
      r.drained.send_chain_ms);
  emit("HITCH", body);
}

}  // namespace

void phase_done(Phase p) {
  const s64 now = now_ns();
  Recorder& r = g_rec;
  if (r.cursor_ns != 0) {
    r.phase_ns[static_cast<int>(p)] += now - r.cursor_ns;
  }
  r.cursor_ns = now;
}

void note_no_chain() {
  g_rec.no_chain_this_frame = true;
}

void note_limiter_oversleep_ms(double ms_late) {
  g_rec.limiter_oversleep_ns = static_cast<s64>(ms_late * 1.0e6);
}

void frame_end() {
  Recorder& r = g_rec;
  phase_done(Phase::Post);
  s64 total_ns = 0;
  for (s64 v : r.phase_ns) {
    total_ns += v;
  }
  const double frame_ms = ms(total_ns);
  const bool no_chain = r.no_chain_this_frame;
  const double oversleep_ms = ms(r.limiter_oversleep_ns);

  r.drained.compute_ms = ms(r.game.compute_ns.exchange(0, std::memory_order_relaxed));
  r.drained.sync_path_wait_ms = ms(r.game.sync_path_wait_ns.exchange(0, std::memory_order_relaxed));
  r.drained.vsync_wait_ms = ms(r.game.vsync_wait_ns.exchange(0, std::memory_order_relaxed));
  r.drained.send_chain_ms = ms(r.game.send_chain_ns.exchange(0, std::memory_order_relaxed));

  r.frame_number++;
  // The first frame has no beginning to measure from, and the window starts on the second.
  if (total_ns > 0 && r.window_started_ns != 0) {
    r.window_frames++;
    r.window_sum_ms += frame_ms;
    r.window_max_ms = std::max(r.window_max_ms, frame_ms);
    if (no_chain) {
      r.window_no_chain++;
    }
    if (r.frame_times_ms.size() < kStatCapacity) {
      r.frame_times_ms.push_back(static_cast<float>(frame_ms));
    }
    if (frame_ms > r.threshold_ms) {
      r.window_over++;
      log_hitch(frame_ms, no_chain, oversleep_ms);
    }
  }

  const s64 now = r.cursor_ns;
  if (r.window_started_ns == 0) {
    r.window_started_ns = now;
  } else if (ms(now - r.window_started_ns) >= kStatPeriodSeconds * 1000.0) {
    float p99 = 0;
    if (!r.frame_times_ms.empty()) {
      const size_t idx = std::min(r.frame_times_ms.size() - 1,
                                  static_cast<size_t>(r.frame_times_ms.size() * 0.99));
      std::nth_element(r.frame_times_ms.begin(), r.frame_times_ms.begin() + idx,
                       r.frame_times_ms.end());
      p99 = r.frame_times_ms[idx];
    }
    const double mean = r.window_frames ? r.window_sum_ms / r.window_frames : 0.0;
    emit("FRAMESTAT",
         fmt::format("frames={} mean_ms={:.2f} p99_ms={:.1f} max_ms={:.1f} over_{:g}ms={} "
                     "no_chain={} window_s={:.1f}",
                     r.window_frames, mean, p99, r.window_max_ms, r.threshold_ms, r.window_over,
                     r.window_no_chain, ms(now - r.window_started_ns) / 1000.0));
    r.window_started_ns = now;
    r.frame_times_ms.clear();
    r.window_frames = r.window_over = r.window_no_chain = 0;
    r.window_sum_ms = r.window_max_ms = 0;
  }

  r.phase_ns.fill(0);
  r.limiter_oversleep_ns = 0;
  r.no_chain_this_frame = false;
}

ScopedGameCall::ScopedGameCall(GameCall which) : m_which(which), m_start_ns(now_ns()) {
  if (m_which == GameCall::SyncPath) {
    const s64 returned = g_rec.game.vsync_returned_at_ns.load(std::memory_order_relaxed);
    if (returned != 0) {
      store_max(g_rec.game.compute_ns, m_start_ns - returned);
    }
  }
}

ScopedGameCall::~ScopedGameCall() {
  const s64 end = now_ns();
  const s64 took = end - m_start_ns;
  switch (m_which) {
    case GameCall::SyncPath:
      store_max(g_rec.game.sync_path_wait_ns, took);
      break;
    case GameCall::VSync:
      store_max(g_rec.game.vsync_wait_ns, took);
      g_rec.game.vsync_returned_at_ns.store(end, std::memory_order_relaxed);
      break;
    case GameCall::SendChain:
      store_max(g_rec.game.send_chain_ns, took);
      break;
  }
}

u32 hitch_count() {
  return g_rec.hitches.load(std::memory_order_relaxed);
}

u64 monotonic_us() {
  return static_cast<u64>(now_ns() / 1000);
}

void emit(const char* tag, const std::string& body) {
  const auto wall = std::chrono::system_clock::now();
  const auto since_epoch = wall.time_since_epoch();
  const time_t secs = std::chrono::duration_cast<std::chrono::seconds>(since_epoch).count();
  const int millis =
      static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(since_epoch).count() %
                       1000);
  struct tm local {};
  localtime_r(&secs, &local);
  char stamp[32];
  std::strftime(stamp, sizeof(stamp), "%Y-%m-%d %H:%M:%S", &local);
  // One write for the whole line, so a line from another thread cannot land in the middle of it.
  const std::string line = fmt::format("{} t={}.{:03d} {}\n", tag, stamp, millis, body);
  std::fwrite(line.data(), 1, line.size(), stdout);
  std::fflush(stdout);
}

}  // namespace hitch
