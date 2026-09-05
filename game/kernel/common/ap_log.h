#pragma once

// Archipelago item log, drawn as an ImGui overlay rather than with the GOAL font.
//
// jak1's font is a bitmap authored for 512x224, so on a modern display every glyph
// is magnified several times and looks mushy no matter where it is placed. ImGui
// already renders into the game window with a real TTF font, so the overlay is
// crisp at any resolution and is still captured by OBS, which a separate window
// would not be.
//
// GOAL pushes lines through pc-ap-log-set; the renderer reads them each frame.

#include <array>
#include <string>

namespace ap_log {
constexpr int kLines = 3;
extern std::array<std::string, kLines> lines;  // 0 is newest
extern bool active;
}  // namespace ap_log
