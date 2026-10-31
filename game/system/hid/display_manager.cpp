#include "display_manager.h"

#include <cmath>
#include <cstdlib>

#include "sdl_util.h"

#include "common/global_profiler/GlobalProfiler.h"

#include "game/graphics/gfx.h"

#include "fmt/format.h"

DisplayManager::DisplayManager(SDL_Window* window) : m_window(window) {
  prof().instant_event("ROOT");
  {
    auto p = scoped_prof("display_manager::init");
    // initialize settings
    m_display_settings = game_settings::DisplaySettings();
#ifdef _WIN32
    // Windows hint to disable OS level forced scaling and allow native resolution at non 100%
    // scales
    SetProcessDPIAware();
#endif
    update_curr_display_info();
    update_video_modes();
    // TODO - might be a good idea to end if no monitor is connected but...?
    // Load from file now (after initializing current window settings)
    m_display_settings.load_settings();
    // Adjust window / monitor position
    initialize_window_position_from_settings();
    set_display_mode(m_display_settings.display_mode, m_window_width, m_window_height);
  }
}

DisplayManager::~DisplayManager() {
  prof().instant_event("ROOT");
  {
    auto p = scoped_prof("display_manager::destroy");
    if (m_display_settings.display_mode == game_settings::DisplaySettings::DisplayMode::Windowed) {
      m_display_settings.window_xpos = m_window_xpos;
      m_display_settings.window_ypos = m_window_ypos;
    }
    m_display_settings.save_settings();
  }
}

void DisplayManager::initialize_window_position_from_settings() {
  // Check that the display id is still valid
  // Not to be confused with the new SDL_DisplayId, this is more like the display_index
  if (m_display_settings.display_id >= m_current_display_modes.size()) {
    lg::warn("[DISPLAY] Saved display ID is no longer valid, resetting to display 0");
    m_display_settings.display_id = 0;
    m_display_settings.window_xpos = 50;
    m_display_settings.window_ypos = 50;
    m_display_settings.save_settings();
  }

  SDL_Rect rect;
  const auto sdl_display_id =
      m_current_display_modes.at(m_display_settings.display_id).sdl_display_id;
  if (!SDL_GetDisplayBounds(sdl_display_id, &rect)) {
    sdl_util::log_error(
        fmt::format("unable to get display bounds for display index: {}, display id {}",
                    m_display_settings.display_id, sdl_display_id));
  } else {
    // Adjust the settings if they are out of bounds
    if (m_display_settings.window_xpos <= rect.x ||
        m_display_settings.window_xpos + 50 >= rect.x + rect.w) {
      lg::warn("[DISPLAY] Saved xpos is out of bounds, resetting");
      m_display_settings.window_xpos = rect.x + 50;
      m_display_settings.save_settings();
    }
    if (m_display_settings.window_ypos <= rect.y ||
        m_display_settings.window_ypos + 50 > rect.y + rect.h) {
      lg::warn("[DISPLAY] Saved ypos is out of bounds, resetting");
      m_display_settings.window_ypos = rect.y + 50;
      m_display_settings.save_settings();
    }
  }

  SDL_SetWindowPosition(m_window, m_display_settings.window_xpos, m_display_settings.window_ypos);
}

void DisplayManager::process_sdl_event(const SDL_Event& event) {
  const auto event_type = event.type;
  if (event_type >= SDL_EVENT_WINDOW_FIRST && event_type <= SDL_EVENT_WINDOW_LAST) {
    // https://wiki.libsdl.org/SDL3/SDL_WindowEvent
    switch (event.window.type) {
      case SDL_EVENT_WINDOW_MINIMIZED:
        m_window_state = WindowState::Minimized;
        break;
      case SDL_EVENT_WINDOW_MAXIMIZED:
        m_window_state = WindowState::Maximized;
        break;
      case SDL_EVENT_WINDOW_RESTORED:
        m_window_state = WindowState::Restored;
        break;
      case SDL_EVENT_WINDOW_MOVED:
        m_window_xpos = event.window.data1;
        m_window_ypos = event.window.data2;
        break;
      case SDL_EVENT_WINDOW_RESIZED:
      case SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED:
        m_window_width = event.window.data1;
        m_window_height = event.window.data2;
        break;
      case SDL_EVENT_WINDOW_DISPLAY_CHANGED:
        // NOTE - if the user changes the window to a display that doesn't support the same
        // framerate we don't handle that
        update_curr_display_info();
        break;
      case SDL_EVENT_WINDOW_MOUSE_ENTER:
        if (m_input_manager && m_input_manager.value()->auto_hiding_cursor()) {
          m_input_manager.value()->hide_cursor(true);
        }
        break;
      case SDL_EVENT_WINDOW_MOUSE_LEAVE:
        m_input_manager.value()->hide_cursor(false);
        break;
    }
  } else if (event_type >= SDL_EVENT_DISPLAY_FIRST && event_type <= SDL_EVENT_DISPLAY_LAST) {
    // https://wiki.libsdl.org/SDL3/SDL_DisplayEvent
    switch (event.display.type) {
      case SDL_EVENT_DISPLAY_ADDED:
      case SDL_EVENT_DISPLAY_REMOVED:
        update_curr_display_info();
        update_video_modes();
        break;
      case SDL_EVENT_DISPLAY_ORIENTATION:
        update_video_modes();
        break;
    }
  }
}

void DisplayManager::process_ee_events() {
  const std::lock_guard<std::mutex> lock(event_queue_mtx);
  // Fully process any events from the EE
  while (!ee_event_queue.empty()) {
    const auto& evt = ee_event_queue.front();
    switch (evt.type) {
      case EEDisplayEventType::SET_WINDOW_SIZE:
        set_window_size(std::get<int>(evt.param1), std::get<int>(evt.param2));
        break;
      case EEDisplayEventType::SET_DISPLAY_MODE:
        set_display_mode(std::get<game_settings::DisplaySettings::DisplayMode>(evt.param1),
                         std::get<int>(evt.param2), std::get<int>(evt.param3));
        break;
      case EEDisplayEventType::SET_DISPLAY_ID:
        set_display_id(std::get<int>(evt.param1));
        break;
      case EEDisplayEventType::SET_FULLSCREEN_GAME_SIZE:
        set_fullscreen_game_size(std::get<int>(evt.param1), std::get<int>(evt.param2));
        break;
    }
    ee_event_queue.pop();
  }
}

std::string DisplayManager::get_connected_display_name(int id) {
  if (m_current_display_modes.size() > id) {
    return m_current_display_modes.at(id).display_name;
  }
  return "";
}

int DisplayManager::get_active_display_refresh_rate() {
  const auto display_index = get_active_display_index();
  if (m_current_display_modes.size() > display_index) {
    return round(m_current_display_modes.at(display_index).refresh_rate);
  }
  return 0;
}

int DisplayManager::get_screen_width() {
  const auto display_index = get_active_display_index();
  if (m_current_display_modes.size() > display_index) {
    return m_current_display_modes.at(display_index).screen_width;
  }
  return 640;
}

int DisplayManager::get_screen_height() {
  const auto display_index = get_active_display_index();
  if (m_current_display_modes.size() > display_index) {
    return m_current_display_modes.at(display_index).screen_height;
  }
  return 480;
}

int DisplayManager::get_num_resolutions(bool for_window_size) {
  if (for_window_size) {
    return m_available_window_sizes.size();
  }
  return m_available_resolutions.size();
}

Resolution DisplayManager::get_resolution(int id, bool for_window_size) {
  if (for_window_size && id < (int)m_available_window_sizes.size()) {
    return m_available_window_sizes.at(id);
  } else if (id < (int)m_available_resolutions.size()) {
    return m_available_resolutions.at(id);
  }
  return {0, 0, 0.0};
}

bool DisplayManager::is_supported_resolution(int width, int height) {
  for (const auto& resolution : m_available_resolutions) {
    if (resolution.width == width && resolution.height == height) {
      return true;
    }
  }
  lg::warn("[DISPLAY] {}x{} is not a supported resolution", width, height);
  return false;
}

void DisplayManager::enqueue_set_window_size(int width, int height) {
  const std::lock_guard<std::mutex> lock(event_queue_mtx);
  ee_event_queue.push({EEDisplayEventType::SET_WINDOW_SIZE, width, height});
}

void DisplayManager::set_window_size(int width, int height) {
  SDL_SetWindowSize(m_window, width, height);
}

void DisplayManager::enqueue_set_window_display_mode(
    game_settings::DisplaySettings::DisplayMode mode,
    const int window_width,
    const int window_height) {
  const std::lock_guard<std::mutex> lock(event_queue_mtx);
  ee_event_queue.push({EEDisplayEventType::SET_DISPLAY_MODE, mode, window_width, window_height});
}

void DisplayManager::set_display_mode(game_settings::DisplaySettings::DisplayMode mode,
                                      const int window_width,
                                      const int window_height) {
  lg::info("[DISPLAY] Setting to display mode: {}, with window_size: {},{}", static_cast<int>(mode),
           window_width, window_height);
  // https://wiki.libsdl.org/SDL3/SDL_SetWindowFullscreen
  int result = 0;
  switch (mode) {
    case game_settings::DisplaySettings::DisplayMode::Windowed:
      if (SDL_SetWindowFullscreen(m_window, false)) {
        lg::info("[DISPLAY] windowed mode - resizing window to {}x{}", window_width, window_height);
        if (!SDL_SetWindowSize(m_window, window_width, window_height)) {
          sdl_util::log_error("unable to change window size");
        }
        // if we are changing from fullscreen/borderless back to windowed - make sure it's not
        // annoyingly at the edge of the screen
        if (m_display_settings.display_mode !=
                game_settings::DisplaySettings::DisplayMode::Windowed &&
            !SDL_SetWindowPosition(m_window, SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED)) {
          sdl_util::log_error(fmt::format("unable to move window to center"));
          break;
        }
      } else {
        sdl_util::log_error("unable to change window to windowed mode");
      }
      break;
    case game_settings::DisplaySettings::DisplayMode::Fullscreen: {
      if (!set_fullscreen_mode()) {
        break;
      }
      if (!SDL_SetWindowFullscreen(m_window, true)) {
        sdl_util::log_error(fmt::format("unable to enable fullscreen mode on window"));
        break;
      }
      break;
    }
    case game_settings::DisplaySettings::DisplayMode::Borderless: {
      // Move the window to the correct display first
      SDL_Rect rect;
      const auto sdl_display_id =
          m_current_display_modes.at(m_display_settings.display_id).sdl_display_id;
      if (!SDL_GetDisplayBounds(sdl_display_id, &rect)) {
        sdl_util::log_error(
            fmt::format("unable to get display bounds for display index: {}, display id {}",
                        m_display_settings.display_id, sdl_display_id));
        break;
      } else if (!SDL_SetWindowPosition(m_window, rect.x, rect.y)) {
        sdl_util::log_error(
            fmt::format("unable to move window before enabling borderless windowed mode"));
        break;
      }
      if (!SDL_SyncWindow(m_window)) {
        sdl_util::log_error(
            fmt::format("failed waiting to move window before enabling borderless windowed mode"));
        break;
      }
      if (!SDL_SetWindowFullscreenMode(m_window, NULL)) {
        sdl_util::log_error(fmt::format("unable to set borderless fullscreen display mode"));
        break;
      }
      if (!SDL_SetWindowFullscreen(m_window, true)) {
        sdl_util::log_error(fmt::format("unable to enable borderless fullscreen mode on window"));
        break;
      }
      break;
    }
  }
  if (result != 0) {
    sdl_util::log_error(
        fmt::format("unable to change window display mode to {}", fmt::underlying(mode)));
  } else {
    // Set the mode, now that we've been successful
    m_display_settings.display_mode = mode;
    m_display_settings.save_settings();
  }
}

/// Which monitor mode exclusive fullscreen should ask for. The desktop mode is the fallback, and
/// it is what fullscreen always used: on a HiDPI Mac that leaves the monitor at its scaled
/// "looks like" mode, so the compositor and anything capturing the screen keep working at the
/// panel's full pixel count however small the game renders.
///
/// On macOS the choice is instead the real mode closest to the game's size at pixel density 1,
/// so a 1920x1080 game puts the monitor at 1920x1080. The refresh rate is the highest one the
/// monitor offers at that size that does not exceed the desktop's and is a whole multiple of the
/// frame rate the game runs at (60 fps on a 144 Hz desktop gives 120 Hz, two refreshes per frame
/// where 144 gives two and a bit, which is uneven pacing).
bool DisplayManager::choose_fullscreen_mode(SDL_DisplayID display_id, SDL_DisplayMode* chosen) {
  const auto desktop = SDL_GetDesktopDisplayMode(display_id);
  if (!desktop) {
    sdl_util::log_error(fmt::format("unable to get the desktop display mode for display id {}",
                                    display_id));
    return false;
  }
  *chosen = *desktop;
#ifdef __APPLE__
  if (m_fullscreen_game_width <= 0 || m_fullscreen_game_height <= 0) {
    lg::info("[DISPLAY] fullscreen game size not reported yet, using the desktop mode for now");
    return true;
  }
  SDL_DisplayMode size_match;
  if (!SDL_GetClosestFullscreenDisplayMode(display_id, m_fullscreen_game_width,
                                           m_fullscreen_game_height, desktop->refresh_rate, false,
                                           &size_match)) {
    sdl_util::log_error(fmt::format("no display mode near {}x{}, using the desktop mode",
                                    m_fullscreen_game_width, m_fullscreen_game_height));
    return true;
  }
  int count = 0;
  SDL_DisplayMode** modes = SDL_GetFullscreenDisplayModes(display_id, &count);
  if (!modes) {
    return true;
  }
  const float fps = Gfx::g_global_settings.target_fps > 0 ? Gfx::g_global_settings.target_fps : 60.f;
  const SDL_DisplayMode* best = nullptr;
  bool best_is_multiple = false;
  for (int i = 0; i < count; i++) {
    const SDL_DisplayMode* mode = modes[i];
    if (!mode || mode->w != size_match.w || mode->h != size_match.h ||
        mode->pixel_density > 1.0f) {
      continue;
    }
    if (mode->refresh_rate > desktop->refresh_rate + 0.5f) {
      continue;
    }
    const float ratio = mode->refresh_rate / fps;
    const bool is_multiple = ratio >= 0.99f && std::fabs(ratio - std::round(ratio)) < 0.01f;
    const bool better =
        !best || (is_multiple && !best_is_multiple) ||
        (is_multiple == best_is_multiple && mode->refresh_rate > best->refresh_rate);
    if (better) {
      best = mode;
      best_is_multiple = is_multiple;
    }
  }
  if (best) {
    *chosen = *best;
  } else {
    *chosen = size_match;
  }
  SDL_free(modes);
#endif
  return true;
}

/// Sets the window's fullscreen mode, which is what the monitor is switched to when the window
/// goes fullscreen. A mode that is not the desktop's is an exclusive one: SDL then does not use
/// a macOS Space for it, switches the monitor itself when the window enters fullscreen, and puts
/// the desktop mode back when it leaves (and when the process ends).
bool DisplayManager::set_fullscreen_mode() {
  if (m_current_display_modes.size() <= get_active_display_index()) {
    lg::error("Display index out of range, cannot switch to fullscreen");
    return false;
  }
  const auto display_id = m_current_display_modes.at(get_active_display_index()).sdl_display_id;
  SDL_DisplayMode mode;
  if (!choose_fullscreen_mode(display_id, &mode)) {
    return false;
  }
  if (!SDL_SetWindowFullscreenMode(m_window, &mode)) {
    sdl_util::log_error(fmt::format("unable to set fullscreen display mode"));
    return false;
  }
  m_fullscreen_mode_width = mode.w;
  m_fullscreen_mode_height = mode.h;
  m_fullscreen_mode_refresh = mode.refresh_rate;
  const auto desktop = SDL_GetDesktopDisplayMode(display_id);
  lg::info("[DISPLAY] fullscreen mode {}x{}@{:.0f}Hz density {} (desktop {}x{}@{:.0f}Hz, game size "
           "{}x{})",
           mode.w, mode.h, mode.refresh_rate, mode.pixel_density, desktop ? desktop->w : 0,
           desktop ? desktop->h : 0, desktop ? desktop->refresh_rate : 0.f,
           m_fullscreen_game_width, m_fullscreen_game_height);
  return true;
}

void DisplayManager::enqueue_set_fullscreen_game_size(int width, int height) {
  // Called every frame, so the common case (nothing changed) must not touch the queue's mutex.
  const u64 packed = (static_cast<u64>(static_cast<u32>(width)) << 32) | static_cast<u32>(height);
  if (m_reported_fullscreen_size.exchange(packed) == packed) {
    return;
  }
  const std::lock_guard<std::mutex> lock(event_queue_mtx);
  ee_event_queue.push({EEDisplayEventType::SET_FULLSCREEN_GAME_SIZE, width, height});
}

void DisplayManager::set_fullscreen_game_size(int width, int height) {
  m_fullscreen_game_width = width;
  m_fullscreen_game_height = height;
  // A window that is already fullscreen follows the size, so the monitor is never left at a mode
  // chosen before the game said what it renders at.
  if (m_display_settings.display_mode != game_settings::DisplaySettings::DisplayMode::Fullscreen ||
      !(SDL_GetWindowFlags(m_window) & SDL_WINDOW_FULLSCREEN)) {
    return;
  }
  const auto before_w = m_fullscreen_mode_width;
  const auto before_h = m_fullscreen_mode_height;
  const auto before_refresh = m_fullscreen_mode_refresh;
  SDL_DisplayMode mode;
  const auto display_id = m_current_display_modes.at(get_active_display_index()).sdl_display_id;
  if (choose_fullscreen_mode(display_id, &mode) && mode.w == before_w && mode.h == before_h &&
      mode.refresh_rate == before_refresh) {
    return;
  }
  set_fullscreen_mode();
}

void DisplayManager::toggle_display_mode() {
  const auto current_mode = m_display_settings.display_mode;
  // Store the current prefered fullscreen mode
  if (current_mode != game_settings::DisplaySettings::DisplayMode::Windowed) {
    m_previous_fullscreen_display_mode = current_mode;
  }
  lg::info("Current display mode: ");
  switch (current_mode) {
    case game_settings::DisplaySettings::DisplayMode::Fullscreen:
    case game_settings::DisplaySettings::DisplayMode::Borderless:
      lg::info("Fullscreen/Borderless\n");
      lg::info("Switching to Windowed mode...\n");
      enqueue_set_window_display_mode(game_settings::DisplaySettings::DisplayMode::Windowed, 0, 0);
      break;

    case game_settings::DisplaySettings::DisplayMode::Windowed:
      lg::info("Windowed\n");
      if (m_previous_fullscreen_display_mode ==
          game_settings::DisplaySettings::DisplayMode::Fullscreen) {
        lg::info("Switching to Fullscreen mode...\n");
      } else if (m_previous_fullscreen_display_mode ==
                 game_settings::DisplaySettings::DisplayMode::Borderless) {
        lg::info("Switching to Borderless mode...\n");
      } else {
        lg::info("Switching to unknown preferred mode...\n");
      }
      // TODO - we'd have to track the intended window size, that info is stored in the GOAL
      // settings right now so clean this and a few other things up eventually when those settings
      // are extracted out of there for now, just use the default window size.
      enqueue_set_window_display_mode(m_previous_fullscreen_display_mode, 640, 480);
      break;

    default:
      lg::info("Unknown display mode!\n");
      break;
  }
}

void DisplayManager::enqueue_set_display_id(int display_id) {
  const std::lock_guard<std::mutex> lock(event_queue_mtx);
  ee_event_queue.push({EEDisplayEventType::SET_DISPLAY_ID, display_id, {}});
}

void DisplayManager::set_display_id(int display_id) {
  lg::info("[DISPLAY] Setting display id to: {}", display_id);
  if (display_id >= (int)m_current_display_modes.size()) {
    display_id = 0;
  }
  m_display_settings.display_id = display_id;
  if (get_display_mode() != game_settings::DisplaySettings::DisplayMode::Windowed) {
    set_display_mode((game_settings::DisplaySettings::DisplayMode)m_display_settings.display_mode,
                     0, 0);
  }
  m_display_settings.save_settings();
}

void DisplayManager::update_curr_display_info() {
  lg::info("[DISPLAY] Updating current display info");
  const auto current_sdl_display_id = SDL_GetDisplayForWindow(m_window);
  if (current_sdl_display_id == 0) {
    sdl_util::log_error("could not retrieve current window's sdl display id");
    return;
  }
  int num_displays = 0;
  const auto display_ids = SDL_GetDisplays(&num_displays);
  if (num_displays < 0 || !display_ids) {
    sdl_util::log_error("could not retrieve sdl display ids");
    return;
  }
  int display_index = -1;
  for (int i = 0; i < num_displays; i++) {
    if (current_sdl_display_id == display_ids[i]) {
      display_index = i;
      break;
    }
  }
  if (display_index == -1) {
    sdl_util::log_error("could not retrieve current window's display index");
    return;
  }
  m_display_settings.display_id = display_index;
  lg::info("[DISPLAY] current display index is {}", m_display_settings.display_id);
  SDL_GetWindowSizeInPixels(m_window, &m_window_width, &m_window_height);
  SDL_GetWindowPosition(m_window, &m_window_xpos, &m_window_ypos);
  // Update the scale of the display as well
  // TODO - figure out how to do this on SDL
  // https://github.com/libsdl-org/SDL/commit/ab81a559f43abc0858c96788f8e00bbb352287e8
  m_window_scale_x = 1.0;
  m_window_scale_y = 1.0;
}

void DisplayManager::update_video_modes() {
  lg::info("[DISPLAY] Enumerating video modes");
  int num_displays = 0;
  const auto display_ids = SDL_GetDisplays(&num_displays);
  if (num_displays < 0 || !display_ids) {
    sdl_util::log_error("could not retrieve display ids");
    return;
  }

  m_current_display_modes.clear();
  for (int i = 0; i < num_displays; i++) {
    SDL_DisplayID display_id = display_ids[i];
    const auto curr_mode = SDL_GetCurrentDisplayMode(display_id);
    if (!curr_mode) {
      sdl_util::log_error(
          fmt::format("couldn't retrieve current display mode for display id {}", display_id));
      continue;
    }
    auto display_orient = SDL_GetCurrentDisplayOrientation(display_id);
    Orientation orient = Orientation::Unknown;
    switch (display_orient) {
      case SDL_ORIENTATION_LANDSCAPE:
        orient = Orientation::Landscape;
        break;
      case SDL_ORIENTATION_LANDSCAPE_FLIPPED:
        orient = Orientation::LandscapeFlipped;
        break;
      case SDL_ORIENTATION_PORTRAIT:
        orient = Orientation::Portrait;
        break;
      case SDL_ORIENTATION_PORTRAIT_FLIPPED:
        orient = Orientation::PortraitFlipped;
        break;
      default:
        orient = Orientation::Unknown;
    }

    std::string display_name_str = "";
    const auto display_name = SDL_GetDisplayName(display_id);
    if (display_name == NULL) {
      sdl_util::log_error(fmt::format("couldn't retrieve display name with id {}", display_id));
    } else {
      display_name_str = display_name;
    }

    DisplayMode new_mode = {display_id,   display_name_str, curr_mode->format,
                            curr_mode->w, curr_mode->h,     curr_mode->refresh_rate,
                            orient};
    m_current_display_modes.push_back(new_mode);
    lg::info(
        "[DISPLAY]: Found monitor {}, currently set to {}x{}@{}hz. Format: {}, Orientation: {}",
        new_mode.display_name, new_mode.screen_width, new_mode.screen_height, new_mode.refresh_rate,
        new_mode.sdl_pixel_format, static_cast<int>(new_mode.orientation));
  }
  update_resolutions();
}

void DisplayManager::update_resolutions() {
  lg::info("[DISPLAY] Enumerating resolutions");
  // Enumerate display's display modes to get the resolutions
  const auto active_display_index = get_active_display_index();
  if (active_display_index >= m_current_display_modes.size()) {
    lg::error("Unable to enumerate resolutions, cant retrieve display mode");
  }
  const auto active_display_mode = m_current_display_modes.at(active_display_index);
  const auto active_refresh_rate = active_display_mode.refresh_rate;
  int num_display_modes = 0;
  SDL_DisplayMode** modes =
      SDL_GetFullscreenDisplayModes(active_display_mode.sdl_display_id, &num_display_modes);
  if (!modes) {
    sdl_util::log_error(
        fmt::format("Unable to retrieve display modes for display id: {}", active_display_index));
    return;
  }

  for (int i = 0; i < num_display_modes; i++) {
    auto display_mode = modes[i];
    if (!display_mode) {
      sdl_util::log_error(fmt::format("unable to get display mode for display {}, index {}",
                                      active_display_mode.sdl_display_id, i));
      continue;
    }
    Resolution new_res = {
        display_mode->w, display_mode->h,
        static_cast<float>(display_mode->w) / static_cast<float>(display_mode->h)};
    // Skip resolutions that aren't using the current refresh rate, they won't work.
    // For example if your monitor is currently set to `60hz` and the monitor _could_ support
    // resolution X but only at `30hz`...then there's no reason for us to consider it as an option.
    const auto comparison = std::abs(display_mode->refresh_rate - active_refresh_rate);
    if (comparison > 1.0) {
      lg::debug(
          "[DISPLAY]: Skipping {}x{} as it requires {:f}hz but the monitor is currently set to "
          "{:f}hz. Difference: {:f}",
          display_mode->w, display_mode->h, display_mode->refresh_rate, active_refresh_rate,
          comparison);
      // Allow it for windowed mode though
      m_available_window_sizes.push_back(new_res);
      continue;
    }
    lg::info("[DISPLAY]: {}x{} is supported", new_res.width, new_res.height);
    m_available_resolutions.push_back(new_res);
    m_available_window_sizes.push_back(new_res);
  }

  // Sort by area
  std::sort(m_available_resolutions.begin(), m_available_resolutions.end(),
            [](const Resolution& a, const Resolution& b) -> bool {
              return a.width * a.height > b.width * b.height;
            });
  std::sort(m_available_window_sizes.begin(), m_available_window_sizes.end(),
            [](const Resolution& a, const Resolution& b) -> bool {
              return a.width * a.height > b.width * b.height;
            });

  // Remove duplicate resolutions
  m_available_resolutions.erase(
      std::unique(m_available_resolutions.begin(), m_available_resolutions.end(),
                  [](const Resolution& a, const Resolution& b) -> bool {
                    return (a.width == b.width && a.height == b.height);
                  }),
      m_available_resolutions.end());
  m_available_window_sizes.erase(
      std::unique(m_available_window_sizes.begin(), m_available_window_sizes.end(),
                  [](const Resolution& a, const Resolution& b) -> bool {
                    return (a.width == b.width && a.height == b.height);
                  }),
      m_available_window_sizes.end());
}
