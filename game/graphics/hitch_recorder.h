#pragma once

/*!
 * @file hitch_recorder.h
 * Says, after a session, why a frame was late.
 *
 * Two threads make a frame. The game thread (the EE) computes it and hands the renderer a DMA chain;
 * the display thread renders the chain, runs the frame limiter and swaps. A late frame is late for
 * one of three reasons that look the same from outside, so every frame is split into the phase it
 * spent its time in:
 *
 *   wait_for_game_ms     the display thread had nothing to render yet: the GAME was late computing the frame
 *   render_ms            the CPU cost of submitting the frame's draw calls
 *   gui_ms               debug gui, archipelago log, imgui draw
 *   limiter_ms           the frame limiter sleeping or spinning to the target frame time
 *   limiter_oversleep_ms how much longer than asked the limiter's sleep took (the OS woke us late)
 *   swap_present_ms      SDL_GL_SwapWindow: the frame was READY and presenting it waited
 *   input_ms / post_ms   event polling and imgui setup before the frame, bookkeeping after it
 *
 * The phases partition the frame, so they sum to frame_ms. The game thread's own view of the frame
 * rides on the same line (game_*): how long it computed, and how long it sat blocked on the renderer.
 *
 * One HITCH line per frame over JAK_HITCH_MS (default 20), one FRAMESTAT line every 10 s. Nothing is
 * logged, nothing allocated, for a normal frame.
 */

#include <string>

#include "common/common_types.h"

namespace hitch {

enum class Phase { Input, WaitForGame, Render, Gui, Limiter, Swap, Post, Count };

/*! Display thread. Ends the phase that began where the last one ended (or where the last frame did). */
void phase_done(Phase p);
/*! Display thread. Whether the wait for the game's chain gave up (nothing to render this frame). */
void note_no_chain();
/*! Display thread. How much longer than asked the frame limiter's sleep took. */
void note_limiter_oversleep_ms(double ms);
/*! Display thread. Closes the frame: ends the Post phase, then records it and logs it if it was a hitch. */
void frame_end();

/*! The game thread's three calls into the renderer, timed as they are made. */
enum class GameCall { SyncPath, VSync, SendChain };
class ScopedGameCall {
 public:
  explicit ScopedGameCall(GameCall which);
  ~ScopedGameCall();
  ScopedGameCall(const ScopedGameCall&) = delete;
  ScopedGameCall& operator=(const ScopedGameCall&) = delete;

 private:
  GameCall m_which;
  s64 m_start_ns;
};

/*! Hitches logged so far. The GOAL side reads it to know that a second contained one. */
u32 hitch_count();
/*! Monotonic microseconds, for the GOAL side to time things with. */
u64 monotonic_us();
/*! One line of the telemetry log: "<tag> t=<wall clock to the millisecond> <body>". Any thread. */
void emit(const char* tag, const std::string& body);

}  // namespace hitch
