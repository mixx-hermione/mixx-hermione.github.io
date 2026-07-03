/**
 * Loading Facts Carousel
 * Extracted to external file for better caching and non-blocking load
 */
(function() {
  'use strict';

  var facts = [
    "Spatial memory helps us remember 65% more information than text alone.",
    "The human brain processes visual information 60,000x faster than text.",
    "AR/VR training can improve learning retention by up to 75%.",
    "3D visualization reduces design errors by up to 40% in architecture.",
    "Spatial computing is projected to be a $280B industry by 2030.",
    "Interactive 3D content increases engagement by 40% over static media.",
    "Digital twins are transforming how we design and maintain infrastructure.",
    "Poor communication in construction costs the U.S. sector about $17 billion per year.",
    "Workers spend over 35% of their week on non-productive tasks like searching for information.",
    "GPS precision relies on timing measurements accurate to about 100 nanoseconds."
  ];

  // Fisher-Yates shuffle
  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  var shuffled = shuffle(facts.slice());
  var idx = 0;
  var el = document.getElementById('loading-fact');
  if (!el) return;

  function show() {
    el.classList.remove('visible');
    setTimeout(function() {
      el.textContent = shuffled[idx];
      el.classList.add('visible');
      idx = (idx + 1) % shuffled.length;
    }, 400);
  }

  show();
  setInterval(show, 3000);
})();
