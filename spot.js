const { data, error } = await supabase
  .from("spots")
  .insert({
    name: nom,
    description: description,
    category: categorie,
    difficulty: difficulte,
    latitude: latitude,
    longitude: longitude,
    photos: photos
  });
