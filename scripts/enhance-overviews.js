const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const TMDB_API_KEY = process.env.TMDB_API_KEY;

// Enhanced descriptions for popular movies (combining TMDB data with expanded details)
const enhancedDescriptions = {
  // Me Time
  862551: `A stay-at-home dad finds himself with some "me time" for the first time in years while his wife and kids are away. He reconnects with his former best friend Huck for a wild weekend that nearly upends his life. What starts as a simple break from parenting duties quickly spirals into an outrageous adventure filled with unexpected chaos, rekindled friendships, and hilarious misadventures. Starring Kevin Hart and Mark Wahlberg, this comedy explores the balance between family responsibilities and personal freedom, proving that sometimes the best way to appreciate what you have is to step away from it—even if just for a weekend.`,
  
  // Stranger Things
  66732: `When a young boy named Will Byers vanishes from the small town of Hawkins, Indiana, a small town uncovers a mystery involving secret government experiments, terrifying supernatural forces from an alternate dimension called the Upside Down, and one strange little girl with extraordinary psychic powers named Eleven. As Will's mother Joyce desperately searches for her son, his friends Mike, Dustin, and Lucas encounter Eleven and discover that the disappearance is connected to a dark conspiracy involving the nearby Hawkins National Laboratory. The series blends 1980s nostalgia with sci-fi horror, exploring themes of friendship, family, and the courage to face the unknown.`,
  
  // Murder Mystery 2
  638974: `After starting their own detective agency following their previous misadventures, Nick and Audrey Spitz land a career-making case when their billionaire friend Maharajah is kidnapped from his own extravagant wedding on a private island. Racing against time across multiple countries from Paris to the Caribbean, the couple must use their amateur sleuthing skills to navigate a web of eccentric suspects, international criminals, and dangerous situations. With their marriage and friendship on the line, Nick and Audrey prove once again that sometimes the most unlikely detectives can crack the most impossible cases.`,
  
  // Extraction 2
  697843: `Back from the brink of death after his near-fatal mission in Bangladesh, highly skilled black ops mercenary Tyler Rake takes on another impossible and dangerous mission: saving the imprisoned family of a ruthless Georgian gangster from a heavily fortified prison. When he discovers the family includes innocent children trapped by their criminal patriarch, Tyler must navigate deadly prison corridors, face off against an entire army, and confront his own traumatic past to complete the extraction. The film delivers relentless action sequences and explores the cost of redemption in a world of violence.`,
  
  // The Adam Project
  696806: `After accidentally crash-landing in 2022, time-traveling fighter pilot Adam Reed from the year 2050 teams up with his 12-year-old self on a mission to save the future and their family. Together, the two Adams must navigate the complexities of time travel while confronting their shared grief over their father's death and their complicated relationship with their mother. As they race against time to stop a devastating event that will destroy the world, both versions of Adam learn valuable lessons about loss, love, and the importance of treasuring the time we have with the people who matter most.`,
  
  // Don't Look Up
  646380: `Two astronomers—Dr. Randall Mindy and PhD candidate Kate Dibiasky—make the discovery of a lifetime when they spot a massive comet hurtling directly toward Earth with the power to cause an extinction-level event. They embark on a media tour to warn humankind of the impending catastrophe, but their increasingly desperate attempts to alert the world are met with indifference, denial, and political manipulation. The response from a distracted world obsessed with celebrity culture and social media: Meh. This dark satirical comedy explores humanity's inability to address existential threats, featuring an all-star ensemble cast.`,
  
  // Marshall
  392982: `Thurgood Marshall, the first African-American Supreme Court Justice and legendary civil rights lawyer, battles through one of his career-defining cases that would shape his path to the nation's highest court. In 1941, Marshall travels to conservative Connecticut to defend Joseph Spell, a Black chauffeur accused of sexual assault by his wealthy white employer. Forbidden from speaking in the courtroom by a racist judge, Marshall must collaborate with local attorney Sam Friedman to expose the truth and fight against systemic racism in the American legal system. This inspiring true story reveals the early struggles of a legal giant.`,
  
  // Lift
  955916: `An international heist crew, led by the charismatic master thief Cyrus Whitaker, races to pull off their most ambitious and dangerous score yet: lifting $500 million in gold from a passenger plane cruising at 40,000 feet. Recruited by a government agency to intercept the illegal gold shipment being transported by a dangerous arms dealer, the team must execute an impossible mid-air heist while dealing with double-crosses, romantic complications, and a ticking clock. Combining Ocean's Eleven style camaraderie with high-altitude thrills, this action comedy proves that some crimes require thinking way outside the box.`,
  
  // Cinema Paradiso
  11216: `A famous Italian filmmaker named Salvatore returns to his hometown in Sicily for the first time in decades to attend the funeral of Alfredo, the projectionist at the local Cinema Paradiso who served as his mentor and father figure. Through a series of nostalgic flashbacks, we witness young Salvatore's magical discovery of cinema, his deep friendship with Alfredo, and his first love—all set against the backdrop of a small town movie theater that served as the heart and soul of the community. This beloved classic celebrates the transformative power of movies and the bittersweet beauty of memory.`,
  
  // Rear Window
  567: `A wheelchair-bound professional photographer named L.B. Jefferies, confined to his Greenwich Village apartment with a broken leg, begins spying on his neighbors through his rear window to pass the time. What begins as idle curiosity turns into a gripping obsession when he becomes convinced that one of his neighbors—a traveling jewelry salesman—has murdered his nagging wife and disposed of her body. With the help of his elegant girlfriend Lisa and his visiting nurse Stella, Jeff investigates the suspected crime from his window, putting all their lives in danger. Alfred Hitchcock's masterpiece of suspense and voyeurism.`,
  
  // Jumanji: The Next Level
  512200: `When Spencer goes back into the fantastical world of Jumanji, his friends Martha, Fridge, and his grandfather Eddie and his friend Milo are pulled in as well to rescue him. But the game has changed: the gang discovers that nothing is as they expect as new characters and unexplored territories await them. The players will have to brave parts unknown and unexplored, face new dangers and adversaries, and rely on each other more than ever in order to escape the world's most dangerous game. With new avatars, new challenges, and higher stakes, the adventure continues in this action-packed sequel.`
};

async function updateEnhancedOverviews() {
  console.log('Updating enhanced overviews...\n');
  
  for (const [tmdbId, overview] of Object.entries(enhancedDescriptions)) {
    const { data, error } = await supabase
      .from('movies')
      .update({ overview })
      .eq('tmdb_id', parseInt(tmdbId))
      .select('id, title');
    
    if (error) {
      console.log(`Error updating TMDB ${tmdbId}: ${error.message}`);
    } else if (data && data.length > 0) {
      console.log(`✓ Updated: ${data[0].title} (${overview.length} chars)`);
    } else {
      console.log(`Movie with TMDB ${tmdbId} not found in database`);
    }
  }
  
  console.log('\nDone!');
}

updateEnhancedOverviews();
