/**
 * The pieces of a creation: what is given to the model beside its prompt (an image to start from, one to end
 * on, a subject, a video to follow…). (0.6.209) One table of their words for the three screens that show them:
 * the plateau of the Studio (studio.mjs), the card of a proposal in the Chat (video-plan.mjs) and the line of a
 * take to create in the Bobine (montage.mjs). The same piece has the same word everywhere (study of 21/11,
 * « interface simple », § 6, step 3; LOTS.md, lots 12 and 13).
 */

// The word under a piece (captures 93, 105 and 103), by what it is for: a word or two, as a sentence writes
// it. A screen that shows its words in capitals does so in its style sheet.
export const PIECE_WORDS = {
  start_image: 'Début',
  end_image: 'Fin',
  reference: 'Sujet',
  source: 'À modifier',
  // The clip a continuation goes on from; the video a character is put in, and that character (capture 97).
  prolong: 'À prolonger',
  follow: 'À suivre',
  character: 'Personnage',
};

// (Captures 94, 100, 101 and 104) Each kind of piece in a list « Ajouter »: its name, what the list says of it
// once given (`given`), and how a model that does not take it says which one does (`serves`: « Une vidéo à
// suivre sert avec SCAIL-2 : choisissez-le dans Modèle. »).
export const PIECES = {
  start_image: { name: 'Image de début', given: 'déjà donnée', serves: 'Une image de début sert' },
  end_image: { name: 'Image de fin', given: 'déjà donnée', serves: 'Une image de fin sert' },
  source: { name: 'Image à modifier', given: 'déjà donnée', serves: 'Une image à modifier sert' },
  follow: { name: 'Vidéo à suivre', given: 'déjà donnée', serves: 'Une vidéo à suivre sert' },
  character: { name: 'Personnage', given: 'déjà donné', serves: 'Un personnage sert' },
  reference: { name: 'Sujet', given: 'déjà donné', serves: 'Un sujet sert' },
  lyrics: { name: 'Paroles', given: 'déjà ouvertes', serves: 'Des paroles servent' },
  image: { name: 'Image', given: 'déjà donnée', serves: 'Une image sert' },
};

/** A reference of the project as it is written in a message and named on a piece: « #ref3 »; else ''. */
export const refOf = label => (/^#ref\d{1,4}$/i.test(String(label ?? '').trim()) ? String(label).trim().toLowerCase() : '');
