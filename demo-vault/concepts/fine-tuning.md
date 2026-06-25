# Fine-tuning

Fine-tuning adjusts a model's weights on your own examples so it picks up a voice and a body of knowledge that no prompt could fit. We use LoRA, which trains a small adapter instead of the whole model, so it is cheap enough to run on a laptop overnight.

The interesting claim is that training on your notes bakes knowledge into the weights, so the model can answer some things from memory without spending retrieval context on them. Marco owns this part. It pairs naturally with quantization when you want the result to run on a phone.

#concept #ai
