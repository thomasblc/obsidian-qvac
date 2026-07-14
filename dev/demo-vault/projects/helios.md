# Helios

Helios is the side experiment: run a trained adapter offline on a phone. The desktop app does the heavy training, Helios is the lightweight viewer that loads the adapter and answers without a network.

The hard part is size. A phone cannot hold a 4B model comfortably, so Helios leans on aggressive quantization to get a 1.7B model down to something that fits and still runs fast. It shares the same adapter format as the main app, so a model trained on the desktop just works.

#project #mobile
