//
//  SwiftUIView.swift
//  plant-friends
//
//  Created by Saul Shanabrook on 5/2/22.
//

import SwiftUI

struct DetailView: View {
    var plant: PFAFPlant
    
    var body: some View {
        Text(plant.latin_name)
    }
}

struct DetailView_Previews: PreviewProvider {
    static var previews: some View {
        DetailView(plant: PFAFPlant(latin_name: "test"))
    }
}
