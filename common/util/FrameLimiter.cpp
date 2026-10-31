#include "FrameLimiter.h"

#include <algorithm>
#include <thread>

#include "common/common_types.h"

double FrameLimiter::round_to_nearest_60fps(double current) {
  double one_frame = 1.f / 60.f;
  int frames_missed = (current / one_frame);  // rounds down
  if (frames_missed > 4) {
    frames_missed = 4;
  }
  return (frames_missed + 1) * one_frame;
}

#ifdef OS_POSIX

FrameLimiter::FrameLimiter() {}

FrameLimiter::~FrameLimiter() {}

void FrameLimiter::run(double target_fps,
                       bool experimental_accurate_lag,
                       bool do_sleeps,
                       double engine_time) {
  double target_seconds;
  if (experimental_accurate_lag) {
    target_seconds = round_to_nearest_60fps(engine_time);
  } else {
    target_seconds = 1.f / target_fps;
  }
  double remaining_time = target_seconds - m_timer.getSeconds();

  m_oversleep_ms = 0;
  if (do_sleeps && remaining_time > 0.001) {
    const double asked_seconds = remaining_time - 0.001;
    Timer sleep_timer;
    std::this_thread::sleep_for(std::chrono::microseconds(int(asked_seconds * 1e6)));
    m_oversleep_ms = std::max(0.0, sleep_timer.getMs() - asked_seconds * 1e3);
  }

  while (remaining_time > 0) {
    remaining_time = target_seconds - m_timer.getSeconds();
  }

  m_timer.start();
}

#else

#define NOMINMAX
#include <Windows.h>

FrameLimiter::FrameLimiter() {
  timeBeginPeriod(1);
}

FrameLimiter::~FrameLimiter() {
  timeEndPeriod(0);
}

void FrameLimiter::run(double target_fps,
                       bool experimental_accurate_lag,
                       bool do_sleeps,
                       double engine_time) {
  double target_seconds;
  if (experimental_accurate_lag) {
    target_seconds = round_to_nearest_60fps(engine_time);
  } else {
    target_seconds = 1.f / target_fps;
  }
  double remaining_time = target_seconds - m_timer.getSeconds();

  if (do_sleeps && remaining_time > 0.001) {
    Sleep((remaining_time * 1000) - 1);
  }

  while (remaining_time > 0) {
    remaining_time = target_seconds - m_timer.getSeconds();
  }

  m_timer.start();
}

#endif
