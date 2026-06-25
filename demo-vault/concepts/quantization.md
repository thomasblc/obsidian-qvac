# Quantization

Quantization shrinks a model by storing its numbers at lower precision, 4 bits instead of 16, which cuts the memory roughly fourfold for a small quality cost. It is the difference between a model that fits on a phone and one that does not.

It is what makes the mobile viewer possible at all, and it has to be chosen carefully alongside fine-tuning because not every quantized format can still be trained.

#concept #ai
